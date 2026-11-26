"""Actual Chromium/Playwright E2E using only fabricated data and localhost.

Does not launch Finance auth, does not access Microsoft Graph, and never writes a vault.
Uses the actual compiled Finance UI modules and production CSS, not source regexes.
"""
import http.server
from html.parser import HTMLParser
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit, unquote

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


class OfflineFixtureMarkup(HTMLParser):
    """Remove boot scripts and external assets from trusted build markup only."""

    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets = [0] + [i + 1 for i, ch in enumerate(source) if ch == '\n']
        self.ranges = []
        self.script_start = None

    def source_offset(self):
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.script_start = self.source_offset()
        elif tag == 'link' or (tag == 'meta' and any(
            name == 'http-equiv' and (value or '').lower() == 'content-security-policy'
            for name, value in attrs
        )):
            start = self.source_offset()
            self.ranges.append((start, start + len(self.get_starttag_text())))

    def handle_startendtag(self, tag, attrs):
        if tag == 'script':
            # HTML does not support self-closing script elements.
            raise ValueError('Unexpected self-closing script in fixture markup')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == 'script' and self.script_start is not None:
            end = self.source.index('>', self.source_offset()) + 1
            self.ranges.append((self.script_start, end))
            self.script_start = None

    def render(self):
        self.feed(self.source)
        self.close()
        if self.script_start is not None:
            raise ValueError('Unclosed script in fixture markup')
        parts, cursor = [], 0
        for start, end in self.ranges:
            parts.append(self.source[cursor:start])
            cursor = end
        parts.append(self.source[cursor:])
        return ''.join(parts)


class FixtureMarkupTests(unittest.TestCase):
    def test_removes_scripts_regardless_of_case_and_preserves_other_markup(self):
        source = ('<!DOCTYPE html><head>\n'
                  '<SCRIPT src="boot.js"></SCRIPT>\n'
                  '<sCrIpT data-label="a>b">if (1 < 2) { boot(); }</ScRiPt >\n'
                  '<META HTTP-EQUIV="Content-Security-Policy" content="default-src self">\n'
                  '<LiNk rel="stylesheet" href="app.css" />\n'
                  '<title>Fixture &amp; test</title></head><body><p>日本語</p></body>')
        expected = ('<!DOCTYPE html><head>\n\n\n\n\n'
                    '<title>Fixture &amp; test</title></head><body><p>日本語</p></body>')
        self.assertEqual(OfflineFixtureMarkup(source).render(), expected)

    def test_rejects_unclosed_or_self_closing_scripts(self):
        for source in ('<SCRIPT>boot()', '<script src="boot.js"/>'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                OfflineFixtureMarkup(source).render()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        # Serve only the test fixture, production CSS and compiled UI modules.
        # Never expose an app vault, private file or local credential by mistake.
        path = unquote(urlsplit(self.path).path)
        if '..' in path.split('/') or not (
            path == '/tests/e2e/finance-fixture.html' or
            path == '/dist/styles/app.css' or
            path.startswith('/dist/src/') and path.endswith('.js')
        ):
            self.send_error(404)
            return
        super().do_GET()


class FixtureServer(http.server.ThreadingHTTPServer):
    # Python 3.9 defaults to a backlog of five connections. Chromium loads
    # module graphs in parallel; avoid refusing connections during bursts.
    request_queue_size = 128


class FinanceBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = FixtureServer(('127.0.0.1', 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.pw = sync_playwright().start()
        # Playwright installs its own headless shell in CI. Our sandbox may
        # only ship the full Chromium executable: use that as a local fallback.
        from shutil import which
        bundled = Path(cls.pw.chromium.executable_path)
        local = bundled if bundled.is_file() else Path(which('chromium') or '')
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=str(local)) if local.is_file() else cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def create_page(self, mobile=False, width=1100):
        context = self.browser.new_context(viewport={'width': width, 'height': 850},
                                           device_scale_factor=3 if mobile else 1,
                                           is_mobile=mobile, has_touch=mobile)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        # Dynamic import errors name only the entry module. Report the actual
        # failed fixture request, including transitive dependencies, without retry.
        def report_failure(request):
            if request.url.startswith(self.base + '/'):
                print(f'[E2E HTTP] {urlsplit(request.url).path}: {request.failure}', flush=True)
        def report_response(response):
            if response.url.startswith(self.base + '/') and response.status >= 400:
                print(f'[E2E HTTP] {urlsplit(response.url).path}: HTTP {response.status}', flush=True)
        page.on('requestfailed', report_failure)
        page.on('response', report_response)
        page.goto(self.base + '/tests/e2e/finance-fixture.html')
        return page, context, errors

    @staticmethod
    def set_section(page, key):
        page.evaluate('''(section)=>{
          document.querySelectorAll('[id^="e2e-"]').forEach(el=>{if(el.tagName==='SECTION')el.hidden=el.id!==section;});
        }''', 'e2e-' + key)

    @staticmethod
    def point(page, internal_x, internal_y=130):
        return page.locator('.future-chart-svg').evaluate('''(svg,xy)=>{
          const ctm=svg.getScreenCTM();if(!ctm)throw new Error('SVG CTM missing');
          const p=new DOMPoint(xy[0],xy[1]).matrixTransform(ctm);return {x:p.x,y:p.y};
        }''', [internal_x, internal_y])

    @staticmethod
    def prepare_graph(page):
        page.evaluate('''async()=>{
          const now=new Date(),day=new Date(now.getFullYear(),now.getMonth(),1).toISOString();
          const assets={birthMonth:'2000-01',nisaCardRule:null,recurring:[],oneTime:[],snapshots:[
            {id:'confirmed-cash',accountId:'cash-savings',balance:100000,observedAt:day},
            {id:'confirmed-nisa',accountId:'nisa',balance:200000,observedAt:day},
          ]};
          const mod=await import('/dist/src/ui/future-projection.js');
          window.financeFutureE2E=mod.initFutureProjection(()=>({assets,records:[]}));
          window.financeFutureE2E.render();
        }''')
        page.locator('.future-chart-svg').wait_for()
        assert page.locator('.future-chart-svg').get_attribute('aria-valuemax') is not None

    @staticmethod
    def offline_document(import_workspace=False):
        import base64, json, re
        # Trusted build fixture only; production CSP is independently audited.
        html=OfflineFixtureMarkup((ROOT/'dist/index.html').read_text(encoding='utf-8')).render()
        html=html.replace('</head>','<style>'+(ROOT/'dist/styles/app.css').read_text(encoding='utf-8')+'</style></head>')
        module_root=(ROOT/'dist/src').resolve()
        modules={}
        def module_key(file):return 'finance-fixture/'+file.relative_to(module_root).as_posix()
        for file in module_root.rglob('*.js'):
            def replace_specifier(match):
                target=(file.parent/match.group(2)).resolve()
                if not target.is_relative_to(module_root):raise ValueError('Unexpected fixture module path')
                return match.group(1)+module_key(target)+match.group(3)
            source=re.sub(r"((?:from|import)\s+['\"])(\.{1,2}/[^'\"]+)(['\"])",replace_specifier,file.read_text(encoding='utf-8'))
            if import_workspace and file==module_root/'main.js':
                # Test-only access to real import handlers; do not run auth or startup.
                assert source.rstrip().endswith('init();')
                source=source.rstrip()[:-len('init();')]+"""
window.financeImportTest={
  prepare(records){
    liveVault={unlocked:true,records:()=>structuredClone(records),readonlyRecords:()=>structuredClone(records),assetSettings:()=>({}),merchantRules:()=>[],fixedCostMigrations:()=>[],merchantCategories:()=>[],takeMutationWarning:()=>null,
      async saveBatch(items){for(const item of items){const old=records.find(r=>r.id===item.id);if(!old)throw Error('missing fixture record');if(item.source)throw Error('manual confirmation must preserve original');old.statement=structuredClone(item.statement);}return items.map(item=>item.id);}};
    for(const record of records){const s=structuredClone(record.statement);statements.push(s);savedIds.set(s,record.id);originalSaved.add(s);savedFingerprints.set(s,statementWorkingFingerprint(s));importedSignatures.set(s,statementSignature(s));}
    for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='import-view');
    bindImportCardChoices();render();
  },
  manage(id){
    for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='manage-view');
    manageYear='all';manageMonth='all';activeIndex=statements.findIndex(s=>savedIds.get(s)===id);
    document.getElementById('manage-confirm-statement').onclick=()=>{void confirmManagedStatement();};render();
  },
  drilldown(source,request){
    analysisSourceProvider=()=>source;activeAnalysisDrilldown=request;analysisDrilldownSeed=null;
    for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='manage-view');
    renderManager();
  },
  rulesPicker(records,registered){
    liveVault={unlocked:true,merchantRules:()=>registered,merchantCategories:()=>[],assetSettings:()=>({})};
    for(const record of records){statements.push(record.statement);savedIds.set(record.statement,record.id);}
    for(const id of ['rule-card','recent-merchants-card'])for(const card of CARDS)$(id).append(new Option(card.name,card.id));
    for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='rules-view');
    $('rules-pick-merchant').addEventListener('click',openRecentMerchants);
    $('recent-merchants-card').addEventListener('change',renderRecentMerchants);
    $('recent-merchants-search').addEventListener('input',renderRecentMerchants);
    $('recent-merchants-close').addEventListener('click',()=>$('recent-merchants-dialog').close());
    $('rules-form').addEventListener('input',updateFixedRulePreview);
    $('rules-form').addEventListener('change',updateFixedRulePreview);
    $('rule-reset').addEventListener('click',resetRuleEditor);
    resetRuleEditor();renderRules();
  },
  stored(id){return liveVault.readonlyRecords().find(r=>r.id===id)},
  add(raw){return acceptStatement(parseStatementText(raw,'pdf','synthetic.pdf'),{bytes:new Uint8Array([1,2,3]),mime:'application/pdf'});},
  state(){return importQueue().map(s=>({card:s.cardId,status:s.confirmation,collision:importCollision(s),source:pendingSources.has(s),id:savedIds.get(s)??null}));}
};
"""
            modules[module_key(file)]='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
        html=html.replace('</head>','<script type="importmap">'+json.dumps({'imports':modules})+'</script></head>')
        return html

    def test_import_duplicate_keeps_preview_card_choice_and_revision(self):
        html=self.offline_document(import_workspace=True)
        raw="\n".join(['ご利用代金請求明細書','楽天カード株式会社','2024年04月ご請求金額 ご利用カード','1,000円 楽天カード(Visa) ****-****-****-0000','お支払日 返済方法 引落口座 請求確定日 利用獲得ポイント 調整額 返金額','2024/04/27 口座振替 架空銀行 2024/04/12 10 0円 0円','利用日 利用店名 利用者 支払方法 利用金額 手数料/利息 支払総額 当月請求額 翌月繰越残高','2024/03/03 架空商店 本人 1回払い 1,000 0 1,000 1,000 0'])
        for width,mobile in ((1250,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate("""async raw=>{
                      await import('finance-fixture/main.js');
                      const {parseStatementText}=await import('finance-fixture/importers/statement-parser.js');
                      const s=parseStatementText(raw,'pdf','synthetic.pdf');
                      financeImportTest.prepare([{id:'stored-first',statement:{...s,cardId:'rakuten-etc'}},{id:'stored-second',statement:{...s,cardId:'rakuten-mizuho',confirmation:'provisional'}}]);
                      await financeImportTest.add(raw);
                    }""",raw)
                    state=lambda:page.evaluate('financeImportTest.state()')
                    radios=page.locator('#import-rakuten-choice')
                    radios.locator('input[value="rakuten-etc"]').check(force=True)
                    self.assertEqual(state()[0]['collision'],'duplicate')
                    self.assertTrue(state()[0]['source'])
                    self.assertTrue(page.locator('#preview-content').is_visible())
                    self.assertIn('架空商店',page.locator('#transaction-rows').inner_text())
                    self.assertTrue(page.locator('#batch-import').is_disabled())
                    self.assertEqual(page.locator('#statement-list .statement-card.duplicate').count(),1)
                    self.assertFalse(page.locator('#import-upload-feedback').is_visible())
                    self.assertFalse(page.locator('#import-inline-entry').is_visible())
                    radios.locator('input[value="rakuten-mizuho"]').check(force=True)
                    page.locator('#import-revision-dialog').wait_for()
                    self.assertEqual(page.locator('#import-revision-title').inner_text(),'明細を確定に更新')
                    self.assertEqual(page.locator('#import-revision-accept').inner_text(),'確定に更新')
                    self.assertIn('2024年4月分',page.locator('#import-revision-summary').inner_text())
                    self.assertNotIn('2024-04',page.locator('#import-revision-summary').inner_text())
                    self.assertFalse(page.locator('#import-revision-stats').is_visible())
                    self.assertFalse(page.locator('#import-revision-details').is_visible())
                    page.locator('#import-revision-cancel').click()
                    self.assertEqual(state()[0]['collision'],'revision')
                    self.assertTrue(state()[0]['source'])
                    radios.locator('input[value="rakuten-etc"]').check(force=True)
                    self.assertEqual(state()[0]['collision'],'duplicate')
                    radios.locator('input[value="rakuten-mizuho"]').check(force=True)
                    page.locator('#import-revision-accept').click()
                    self.assertEqual(state(),[{'card':'rakuten-mizuho','status':'confirmed','collision':None,'source':True,'id':'stored-second'}])
                    self.assertTrue(page.locator('#batch-import').is_enabled())
                    page.locator('#statement-list .statement-remove').click()
                    self.assertEqual(state(),[])
                    self.assertTrue(page.locator('#import-inline-entry').is_visible())
                    self.assertFalse(page.locator('#import-upload-feedback').is_visible())
                    self.assertFalse(page.locator('#import-view > .results-grid').is_visible())
                    # Re-import an explicitly provisional PDF against the stored final bill.
                    # It remains inspectable but cannot be saved or manually promoted.
                    provisional_raw=raw+'\n請求金額確定前の明細'
                    page.evaluate('raw=>financeImportTest.add(raw)',provisional_raw)
                    radios.locator('input[value="rakuten-etc"]').check(force=True)
                    self.assertEqual(state()[0]['status'],'provisional')
                    self.assertEqual(state()[0]['collision'],'blocked')
                    self.assertTrue(state()[0]['source'])
                    self.assertTrue(page.locator('#batch-import').is_disabled())
                    self.assertFalse(page.locator('#import-revision-dialog').is_visible())
                    self.assertEqual(page.get_by_text('原本を確認して確定明細として扱う',exact=True).count(),0)
                    self.assertIn('確定済み明細は未確定の明細で置き換えません',page.locator('#notice-list').inner_text())
                    self.assertIn('架空商店',page.locator('#transaction-rows').inner_text())
                    page.locator('#statement-list .statement-remove').click()
                    self.assertEqual(state(),[])
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_saved_unknown_confirmation_and_shared_funding_buttons(self):
        html=self.offline_document(import_workspace=True)
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate("""async()=>{
                      await import('finance-fixture/main.js');
                      const statement={provider:'rakuten',cardId:'rakuten-etc',sourceKind:'pdf',sourceName:'synthetic.pdf',billingMonth:'2024-04',paymentDate:'2024-04-27',statedTotal:1000,confirmation:'unknown',warnings:[],rows:[{id:'stable-row',usedOn:'2024-03-01',merchant:'SAMPLE',merchantOverride:'表示名',amount:1000}]};
                      financeImportTest.prepare([{id:'saved-unknown',originalId:'stable-original',statement}]);financeImportTest.manage('saved-unknown');
                    }""")
                    flag=page.locator('#manage-list .statement-flag')
                    self.assertEqual(flag.inner_text(),'確定状態不明')
                    self.assertIn('金額照合OK・確定状態不明',page.locator('#manage-validation').inner_text())
                    before=page.evaluate("financeImportTest.stored('saved-unknown')")
                    action=page.locator('#manage-confirm-statement');action.click()
                    dialog=page.locator('.finance-confirm-dialog')
                    self.assertEqual(dialog.locator('h2').inner_text(),'明細の確定')
                    self.assertEqual(dialog.locator('.finance-confirm-message').inner_text(),'明細を確定します。よろしいですか？')
                    self.assertEqual(dialog.locator('.finance-modal-actions button').all_text_contents(),['キャンセル','はい'])
                    dialog.get_by_role('button',name='キャンセル').click()
                    self.assertEqual(page.evaluate("financeImportTest.stored('saved-unknown')"),before)
                    action.click();dialog.get_by_role('button',name='はい',exact=True).click()
                    page.wait_for_function("financeImportTest.stored('saved-unknown').statement.confirmation==='confirmed'")
                    before['statement']['confirmation']='confirmed'
                    self.assertEqual(page.evaluate("financeImportTest.stored('saved-unknown')"),before)
                    self.assertEqual(flag.inner_text(),'照合OK');self.assertFalse(action.is_visible())
                    page.evaluate("""async()=>{
                      const {initHome}=await import('finance-fixture/ui/home.js');const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const now=new Date(),prev=new Date(now.getFullYear(),now.getMonth()-1,15),month=`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
                      const assets=emptyAssets();assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:true};assets.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
                      const statement={provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:month,paymentDate:month+'-27',statedTotal:1000,confirmation:'confirmed',warnings:[],rows:[{id:'row',usedOn:month+'-01',merchant:'SAMPLE',amount:1000}]};
                      const source={assets,records:[{id:'bill',statement}],rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}};
                      const home=initHome({source:()=>source,navigate(){},saveMizuhoFunding:async()=>{}});for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!=='home-view');home.render();window.fundingFixture={home,statement};
                    }""")
                    button=page.locator('.home-funding-prior .home-funding-save');copy=page.locator('.home-funding-prior .home-funding-copy')
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        colors=button.evaluate("""b=>{const reference=document.getElementById('manage-save');reference.disabled=false;const s=getComputedStyle(b),r=getComputedStyle(reference);return [s.backgroundColor,s.color,s.borderColor,r.backgroundColor,r.color,r.borderColor]}""")
                        self.assertEqual(colors[:3],colors[3:])
                        self.assertGreaterEqual(button.bounding_box()['x'],copy.bounding_box()['x']+copy.bounding_box()['width']-1)
                        self.assertLessEqual(button.bounding_box()['x']+button.bounding_box()['width'],width+1)
                        if mobile:
                            # Compute the actual picker fill even while its import page is not selected.
                            self.assertEqual(page.locator('#dropzone').evaluate('e=>getComputedStyle(e).backgroundColor'),colors[0])
                    page.evaluate("fundingFixture.statement.confirmation='provisional';fundingFixture.home.render()")
                    review=page.locator('.home-funding-prior .home-funding-review');self.assertTrue(review.is_visible())
                    self.assertTrue(review.evaluate("b=>b.classList.contains('secondary-action')"))
                    self.assertGreaterEqual(review.bounding_box()['x'],copy.bounding_box()['x']+copy.bounding_box()['width']-1)
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_bank_warning_limits_save_and_show_uncertain_shortage(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {localDay}=await import('finance-fixture/cloud/asset-projection.js');
                      const date=new Date(),tomorrow=new Date(date.getFullYear(),date.getMonth(),date.getDate()+1);
                      const data=emptyAssets(),writes=[];
                      data.snapshots=[{id:'balance-r',accountId:'rakuten-bank',balance:190000,observedAt:date.toISOString()}];
                      data.oneTime=[{id:'direct-expense',date:localDay(tomorrow),name:'銀行引落',amount:150000,kind:'expense',status:'planned',fromAccountId:'rakuten-bank',toAccountId:null}];
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>[],async setBalanceWarningLimits(value){writes.push(value);data.balanceWarningLimits=structuredClone(value);}};
                      const source=()=>vault.unlocked?{assets:vault.assetSettings(),records:[],rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}}:null;
                      const assets=initAssetsSettings(()=>vault,()=>[],()=>{});
                      const show=id=>{for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!==id);};
                      const home=initHome({source,navigate(target){if(target==='assets'){show('assets-page');assets.render();}}});
                      window.warningFixture={data,writes,vault,assets,home,show};show('assets-page');assets.render();
                    }''')
                    panel=page.locator('#balance-warning-panel');panel.locator('summary').click()
                    r=panel.locator('#balance-warning-rakuten-bank');m=panel.locator('#balance-warning-mizuho-bank')
                    self.assertEqual(r.input_value(),'0');self.assertEqual(m.input_value(),'0')
                    r.fill('50000');m.fill('10000')
                    page.evaluate('warningFixture.assets.render()')
                    self.assertEqual(r.input_value(),'50000','rerender must preserve unsaved draft')
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        self.assertLessEqual(r.bounding_box()['x']+r.bounding_box()['width'],width+1)
                        self.assertLessEqual(m.bounding_box()['x']+m.bounding_box()['width'],width+1)
                    panel.get_by_role('button',name='保存').click()
                    page.wait_for_function('warningFixture.writes.length===1')
                    self.assertEqual(page.evaluate('warningFixture.writes[0]'),{'rakuten-bank':50000,'mizuho-bank':10000})
                    page.evaluate("warningFixture.show('home-view');warningFixture.home.render()")
                    warning=page.locator('.home-action').filter(has_text='楽天銀行の残高が設定下限を下回る可能性')
                    self.assertTrue(warning.is_visible());self.assertIn('40,000円 / 下限 50,000円',warning.inner_text())
                    warning.click();self.assertTrue(panel.is_visible());self.assertEqual(r.input_value(),'50000')
                    r.fill('0');panel.get_by_role('button',name='保存').click()
                    page.wait_for_function('warningFixture.writes.length===2')
                    page.evaluate("warningFixture.show('home-view');warningFixture.home.render()")
                    self.assertFalse(warning.is_visible())
                    page.evaluate("warningFixture.data.oneTime[0].amount=200000;warningFixture.home.render()")
                    shortage=page.locator('.home-action').filter(has_text='楽天銀行の残高が不足する可能性')
                    self.assertTrue(shortage.is_visible());self.assertIn('不足 10,000円',shortage.inner_text())
                    shortage.click();page.evaluate('warningFixture.vault.unlocked=false;warningFixture.assets.reset()')
                    self.assertEqual(r.input_value(),'');self.assertFalse(panel.is_visible())
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_activity_log_settings_disclosure_retains_errors_and_clears_on_lock(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':760},is_mobile=mobile,has_touch=mobile,reduced_motion='reduce')
                try:
                    page=context.new_page();errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      document.documentElement.classList.remove('finance-nav-boot-collapsed');
                      const activity=await import('finance-fixture/ui/activity-feedback.js');
                      window.activityFixture=activity;activity.initActivityLog();
                      activity.showActivity('架空の警告','warn');activity.showActivity('架空のエラー','bad');
                      document.getElementById('toast').querySelector('button').click();
                      activity.showActivity('架空の保存完了','good');
                      activity.showActivity('架空の処理中','working');activity.showActivity('架空の一般情報','info');
                    }''')
                    self.assertEqual(page.locator('#activity-history-open,#activity-history-dialog,#activity-history-count,#activity-history-read').count(),0)
                    panel=page.locator('.activity-log-panel');logs=page.locator('#activity-log-list')
                    self.assertFalse(panel.is_visible())
                    page.evaluate('''()=>{for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='settings-view');}''')
                    self.assertTrue(panel.is_visible());self.assertEqual(panel.locator('summary strong').inner_text(),'操作ログ')
                    self.assertEqual(panel.evaluate("e=>e.previousElementSibling.id"),'cloud-advanced')
                    self.assertEqual(page.locator('#activity-log-note').count(),0)
                    self.assertFalse(logs.is_visible());self.assertIsNone(panel.get_attribute('open'))
                    panel.locator('summary').click();self.assertTrue(logs.is_visible())
                    page.evaluate("()=>document.getElementById('settings-view').classList.add('cloud-connection-pending')")
                    self.assertFalse(panel.is_visible());self.assertFalse(logs.is_visible())
                    page.evaluate("()=>document.getElementById('settings-view').classList.remove('cloud-connection-pending')")
                    self.assertTrue(panel.is_visible());self.assertTrue(logs.is_visible())
                    panel.locator('summary').click();self.assertFalse(logs.is_visible())
                    panel.locator('summary').click();self.assertTrue(logs.is_visible())
                    self.assertEqual(panel.locator('#activity-log-count').inner_text(),'3件')
                    self.assertEqual(logs.locator('.activity-log-entry').count(),3)
                    self.assertEqual(logs.locator('.activity-log-kind').all_inner_texts(),['完了','エラー','警告'])
                    self.assertIn('架空のエラー',logs.inner_text())
                    self.assertNotIn('架空の処理中',logs.inner_text())
                    self.assertNotIn('架空の一般情報',logs.inner_text())
                    self.assertEqual(panel.evaluate("e=>e.tagName==='DETAILS'&&e.parentElement.closest('details,dialog')===null"),True)
                    self.assertTrue(page.locator('#toast').evaluate("e=>e.classList.contains('visible')"))
                    page.evaluate("()=>{for(let i=0;i<205;i++)activityFixture.showActivity('架空の保存 '+i+' '+('長いログ'.repeat(35)),'good')}")
                    self.assertEqual(logs.locator('.activity-log-entry').count(),200)
                    self.assertIn('8件',page.locator('#activity-log-omitted').inner_text())
                    self.assertIn('架空の保存 204',logs.locator('.activity-log-entry').first.inner_text())
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        result=panel.evaluate('''p=>{const l=p.querySelector('#activity-log-list'),row=l.querySelector('.activity-log-entry'),ref=document.querySelector('#cloud-advanced'),r=p.getBoundingClientRect(),s=getComputedStyle(p),c=getComputedStyle(ref),a=getComputedStyle(p.querySelector('summary')),b=getComputedStyle(ref.querySelector('summary'));return {width:r.width,right:r.right,viewport:document.documentElement.clientWidth,inside:l.scrollWidth<=l.clientWidth+1,scroll:l.scrollHeight>l.clientHeight,cap:l.clientHeight,match:['backgroundColor','borderRadius','borderColor','marginTop','marginBottom'].every(k=>s[k]===c[k])&&['padding','minHeight','fontSize','fontWeight'].every(k=>a[k]===b[k]),font:getComputedStyle(row.querySelector('p')).fontSize}}''')
                        self.assertGreater(result['width'],0);self.assertLessEqual(result['right'],result['viewport']+1)
                        self.assertTrue(result['inside'] and result['scroll'] and result['match'],result)
                        self.assertLessEqual(result['cap'],320);self.assertEqual(result['font'],'13px')
                        logs.evaluate('e=>e.scrollTop=100');self.assertGreater(logs.evaluate('e=>e.scrollTop'),0)
                    page.evaluate('()=>activityFixture.clearActivity()')
                    self.assertTrue(panel.is_visible());self.assertEqual(logs.locator('.activity-log-entry').count(),0)
                    self.assertEqual(logs.inner_text(),'操作ログはありません。');self.assertEqual(logs.evaluate('e=>e.scrollTop'),0)
                    self.assertFalse(page.locator('#activity-log-omitted').is_visible());self.assertEqual(panel.locator('#activity-log-count').inner_text(),'0件')
                    self.assertFalse(page.locator('#toast').evaluate("e=>e.classList.contains('visible')"));self.assertEqual(errors,[])
                finally:context.close()

    def test_shared_period_navigation_and_action_roles(self):
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(390,640,True),(320,480,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort())
                    page.set_content(html)
                    page.evaluate('''async()=>{
                      const nav=await import('finance-fixture/ui/period-navigator.js');
                      const summary=await import('finance-fixture/ui/monthly-summary.js');
                      const analysis=await import('finance-fixture/ui/analysis.js');
                      const reports=await import('finance-fixture/ui/monthly-reports.js');
                      const $=id=>document.getElementById(id);
                      window.summary=summary.initMonthlySummary({source:()=>null,openRecord:()=>{},openDrilldown:()=>{}});
                      window.summary.setPeriod('2026-12');
                      window.analysis=analysis.initAnalysis({source:()=>null,openMonth:()=>{},openDrilldown:()=>{},openSettings:()=>{}});window.analysis.render();
                      const vault={unlocked:true,listArchivedMonths:async()=>[],loadArchivedReport:async()=>null};
                      window.reports=reports.initMonthlyReports({source:()=>null,vault:()=>vault,openMonth:()=>{}});window.reports.openPeriod('2026-12');window.reports.render();
                      window.managerPeriod='2026-12';
                      nav.bindMonthNavigator($('manage-period-controls'),{previous:$('manage-prev-month'),picker:$('manage-period'),next:$('manage-next-month'),current:$('manage-current-month'),all:$('manage-show-all')},()=>window.managerPeriod,next=>window.managerPeriod=next,()=>({label:'請求月',today:'2026-11',all:()=>window.managerPeriod=''}));
                      window.showOnly=(id)=>{for(const view of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"]'))view.classList.toggle('hidden',view.id!==id);};
                      window.showOnly('summary-view');
                    }''')
                    summary=page.locator('#monthly-period-controls')
                    summary.get_by_role('button',name='翌月').click()
                    self.assertEqual(summary.locator('input').input_value(),'2027-01')
                    summary.get_by_role('button',name='前月').click()
                    self.assertEqual(summary.locator('input').input_value(),'2026-12')
                    page.evaluate("window.summary.setPeriod('1900-02')")
                    self.assertTrue(summary.get_by_role('button',name='前月').is_disabled())
                    self.assertFalse(summary.get_by_role('button',name='翌月').is_disabled())
                    page.evaluate("window.summary.setPeriod('2199-12')")
                    self.assertTrue(summary.get_by_role('button',name='翌月').is_disabled())
                    page.evaluate("window.showOnly('manage-view')")
                    manager=page.locator('#manage-period-controls')
                    manager.get_by_role('button',name='翌月').click()
                    self.assertEqual(manager.locator('input').input_value(),'2027-01')
                    manager.get_by_role('button',name='全期間を表示').click()
                    self.assertEqual(manager.locator('input').input_value(),'')
                    self.assertEqual(manager.get_by_role('button',name='全期間を表示').get_attribute('aria-pressed'),'true')
                    manager.get_by_role('button',name='前月').click()
                    self.assertEqual(manager.locator('input').input_value(),'2026-10')
                    manager.get_by_role('button',name='今月に戻る').click()
                    self.assertEqual(manager.locator('input').input_value(),'2026-11')
                    self.assertTrue(manager.evaluate('(el)=>el.previousElementSibling.tagName==="HEADER"'))
                    page.evaluate("window.showOnly('analysis-view')")
                    analysis=page.locator('#analysis-content .finance-period-nav')
                    self.assertTrue(analysis.get_by_role('button',name='翌月').is_disabled())
                    analysis.get_by_role('button',name='前月').click()
                    self.assertFalse(analysis.get_by_role('button',name='翌月').is_disabled())
                    page.evaluate("window.showOnly('reports-view')")
                    reports=page.locator('#reports-content .finance-period-nav')
                    reports.get_by_role('button',name='翌月').click()
                    self.assertEqual(reports.locator('input').input_value(),'2027-01')
                    page.wait_for_function("!document.querySelector('#reports-content .finance-period-nav input').disabled")
                    # Each route uses the same touch dimensions and fits the viewport in both palettes.
                    for view,selector in [('summary-view','#monthly-period-controls'),('manage-view','#manage-period-controls'),('analysis-view','#analysis-content .finance-period-nav'),('reports-view','#reports-content .finance-period-nav')]:
                        page.evaluate('(v)=>window.showOnly(v)',view)
                        result=page.locator(selector).evaluate('''el=>({height:el.querySelector('button').getBoundingClientRect().height, width:el.querySelector('button').getBoundingClientRect().width, fits:[...el.querySelectorAll('button,input')].every(x=>x.getBoundingClientRect().right<=document.documentElement.clientWidth+1)})''')
                        self.assertEqual(result['height'],39,result);self.assertEqual(result['width'],39,result);self.assertTrue(result['fits'],result)
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        result=page.locator('#manage-delete').evaluate('''el=>({danger:el.classList.contains('danger-action'),color:getComputedStyle(el).color,expected:getComputedStyle(el).getPropertyValue('--action-danger-ink').trim()})''')
                        self.assertTrue(result['danger']);self.assertEqual(result['color'],'rgb(165, 45, 55)' if theme=='light' else 'rgb(255, 183, 189)')
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_polish_shared_actions_and_modal_geometry(self):
        html=self.offline_document()
        for width in (1100,390,320):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':750},is_mobile=width<800,has_touch=width<800)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort())
                    page.set_content(html)
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        result=page.evaluate('''()=>{
                          const $=id=>document.getElementById(id), cs=el=>getComputedStyle(el);
                          const actions=['batch-import','manage-save','manage-delete','cloud-login','assets-recurring-save','categories-dialog-save','import-revision-accept'].map(id=>({id,font:cs($(id)).fontSize,min:cs($(id)).minHeight}));
                          $('assets-page').classList.remove('hidden');$('assets-workspace').classList.remove('hidden');
                          const closeIds=['import-add-close','import-revision-close','categories-dialog-close','recent-merchants-close','assets-once-close','legacy-cleanup-close','cloud-connect-close','vault-close'];
                          const closes=closeIds.map(id=>{const el=$(id),dialog=el.closest('dialog');dialog.showModal();const r=el.getBoundingClientRect(),c=cs(el);const d=cs(dialog),dr=dialog.getBoundingClientRect();const result={id,w:r.width,h:r.height,font:c.fontSize,visible:r.width>0&&r.right<=document.documentElement.clientWidth+1,common:dialog.classList.contains('finance-modal'),radius:d.borderRadius,backdrop:getComputedStyle(dialog,'::backdrop').backgroundColor,inside:dr.left>=0&&dr.right<=innerWidth+1&&dr.top>=0&&dr.bottom<=innerHeight+1};dialog.close();return result;});
                          return {actions,closes,originalHidden:$('manage-original-download').classList.contains('hidden'),duplicateSuccess:!!$('verification-ok'),amountDiff:!!$('amount-diff'),revisionText:$('import-revision-dialog').textContent};
                        }''')
                        for item in result['actions']:
                            self.assertEqual(item['font'],'13px',item)
                            self.assertEqual(item['min'],'44px' if width<=800 or item['id']=='cloud-login' else '40px',item)
                        for item in result['closes']:
                            self.assertEqual(item['w'],44 if width<=800 else 40,item)
                            self.assertEqual(item['h'],44 if width<=800 else 40,item)
                            self.assertEqual(item['font'],'25px',item)
                            self.assertTrue(item['visible'],item)
                            self.assertTrue(item['common'] and item['inside'],item)
                            self.assertEqual(item['radius'],'14px',item)
                            self.assertEqual(item['backdrop'],'rgba(12, 24, 42, 0.52)',item)
                        self.assertTrue(result['originalHidden']);self.assertFalse(result['duplicateSuccess']);self.assertTrue(result['amountDiff'])
                        self.assertIn('保存操作でOneDriveへ反映',result['revisionText'])
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_account_individual_balance_save_and_warning_details(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':800},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,validateSnapshot}=await import('finance-fixture/cloud/assets.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      let id=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`synthetic-balance-${++id}`});
                      const data=emptyAssets(),writes=[];let fail=false;
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>[],async addBalanceSnapshots(items){if(fail)throw Error('synthetic write failure');writes.push(structuredClone(items));data.snapshots.push(...items.map(validateSnapshot));}};
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='assets-page');
                      const ui=initAssetsSettings(()=>vault,()=>[],()=>{});ui.render();
                      window.balanceTest={writes,fail:()=>{fail=true},recover:()=>{fail=false},dirty:()=>ui.isDirty()};
                    }''')
                    panel=page.locator('#balance-warning-panel');info=page.locator('#assets-account-info')
                    self.assertFalse(info.is_visible());panel.locator('summary').click();self.assertTrue(info.is_visible());self.assertEqual(info.locator('.assets-info-row').count(),4);panel.locator('summary').click()
                    self.assertEqual(page.locator('#assets-fixed-cost-list, .assets-reconcile-shared, #assets-balances-save').count(),0)
                    self.assertTrue(page.locator('.assets-reconciliation').evaluate_all('nodes=>nodes.length===4&&nodes.every(n=>getComputedStyle(n).display==="none")'))
                    for theme in ('light','dark'):
                        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                        self.assertTrue(page.locator('.assets-balance-form').evaluate_all('forms=>forms.length===4&&forms.every(f=>{const a=f.querySelector("input").getBoundingClientRect(),b=f.querySelector("button").getBoundingClientRect();return b.left>=a.right&&Math.abs(b.bottom-a.bottom)<=2&&f.scrollWidth<=f.clientWidth+2})'))
                    rak=page.get_by_role('spinbutton',name='楽天銀行の残高',exact=True);miz=page.get_by_role('spinbutton',name='みずほ銀行の残高',exact=True)
                    rak.fill('12345');miz.fill('-1')
                    page.get_by_role('button',name='楽天銀行の残高を保存').click();page.wait_for_function('balanceTest.writes.length===1')
                    self.assertEqual(page.evaluate('balanceTest.writes[0].map(x=>[x.accountId,x.balance])'),[['rakuten-bank',12345]])
                    self.assertEqual(rak.input_value(),'');self.assertEqual(miz.input_value(),'-1');self.assertTrue(page.evaluate('balanceTest.dirty()'))
                    miz.fill('0');page.evaluate('balanceTest.fail()');miz.press('Enter');page.wait_for_function('!document.querySelector(".assets-balance-form button").disabled')
                    self.assertEqual(miz.input_value(),'0');self.assertEqual(page.evaluate('balanceTest.writes.length'),1)
                    page.evaluate('balanceTest.recover()');miz.press('Enter');page.wait_for_function('balanceTest.writes.length===2')
                    self.assertEqual(page.evaluate('balanceTest.writes[1].map(x=>[x.accountId,x.balance])'),[['mizuho-bank',0]])
                    self.assertEqual(miz.input_value(),'');self.assertFalse(page.evaluate('balanceTest.dirty()'));self.assertEqual(errors,[])
                finally:context.close()

    def test_fixed_cost_editor_modes_and_account_separation(self):
        # Actual shipped HTML, CSS and UI modules, with a validating in-memory vault.
        # An offline fixture uses an import map of the real compiled modules.
        # No server, auth module or external requests are required for this test.
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(390,640,True),(320,640,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort())
                    page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,validateRecurring,validateAssets,validateOneTime}=await import('finance-fixture/cloud/assets.js');
                      const {applyContractEdit}=await import('finance-fixture/fixed-costs/contract-edit.js');
                      const {initCardSettings}=await import('finance-fixture/ui/card-settings.js');
                      const {validateFixedCosts}=await import('finance-fixture/fixed-costs/contracts.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
                      // The offline fixture has no secure origin. The production app uses WebCrypto.
                      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=> 'synthetic-contract-id'});
                      const data=emptyAssets();const now=new Date();
                      const day=(year,month,d)=>`${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                      const start=day(now.getFullYear()-1,1,1),future=day(now.getFullYear()+1,1,1);
                      data.recurring=[{id:'bank-cost-demo',kind:'expense',name:'銀行固定費テスト',fromAccountId:'rakuten-bank',toAccountId:null,
                        frequency:'monthly',dayOfMonth:31,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:'food',enabled:true,
                        amount:1300,pricing:[{effectiveOn:start,amount:1000},{effectiveOn:future,amount:1300}],pauses:[],priceKind:'fixed',note:'元のメモ'},
                        {id:'income-demo',kind:'income',name:'定期入金テスト',fromAccountId:null,toAccountId:'rakuten-bank',frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:null,enabled:true,amount:4000}];
                      const writes=[];window.financePhase2={data,writes,start,future,today:day(now.getFullYear(),now.getMonth()+1,now.getDate())};
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>[],
                        async deleteRecurring(id){data.recurring=data.recurring.filter(x=>x.id!==id);writes.push({type:'delete-bank',id});},
                        async deleteFixedCost(id){data.fixedCosts=(data.fixedCosts??[]).filter(x=>x.id!==id);writes.push({type:'delete-contract',id});},
                        async upsertOneTime(entry){const valid=validateOneTime(entry);data.oneTime=(data.oneTime??[]).filter(x=>x.id!==entry.id).concat(valid);writes.push({type:'once',entry:structuredClone(valid)});},
                        async deleteOneTime(id){data.oneTime=(data.oneTime??[]).filter(x=>x.id!==id);writes.push({type:'delete-once',id});},
                        async upsertRecurring(entry){const valid=validateRecurring(entry);data.recurring=data.recurring.filter(x=>x.id!==entry.id).concat(valid);writes.push({type:'bank',entry:structuredClone(valid)});},
                        async upsertFixedCost(entry){const valid=validateFixedCosts([entry])[0];data.fixedCosts=(data.fixedCosts??[]).filter(x=>x.id!==entry.id).concat(valid);writes.push({type:'contract',entry:structuredClone(valid)});},
                        async editContract(expected,edit){const entry=applyContractEdit(expected,edit,window.financePhase2.today);const next=structuredClone(data);if(edit.payment)next.format='finance-assets-v2';
                          if('kind' in expected)next.recurring=next.recurring.map(x=>x.id===entry.id?entry:x);else next.fixedCosts=next.fixedCosts.map(x=>x.id===entry.id?entry:x);
                          Object.assign(data,validateAssets(next));writes.push({type:'edit',entry:structuredClone(entry)});}};
                      window.financePhase2.lock=()=>{vault.unlocked=false;assets.reset();subs.reset();};
                      const show=id=>{for(const node of document.querySelectorAll('.workspace .content>section'))node.classList.toggle('hidden',node.id!==id);document.getElementById(id).classList.remove('hidden');};
                      // Keep only the real app sections that are needed for this synthetic exercise.
                      for(const id of ['home-view','import-view','manage-view','rules-view','settings-view','future-view','summary-view','analysis-view','reports-view'])document.getElementById(id).classList.add('hidden');
                      const source=()=>({assets:vault.assetSettings(),records:[],rules:[],categories:[{id:'food',name:'食費',color:null}],payroll:{ready:false,entries:[],syncedAt:null}});
                      const subs=initSubscriptions({source,vault:()=>vault,onSaved:()=>{},openAccountSettings:()=>{}});
                      const assets=initAssetsSettings(()=>vault,()=>[],()=>{},()=>{},id=>{document.getElementById('assets-page').classList.add('hidden');show('subscriptions-view');subs.render();if(id)subs.openFixedCost(id);});
                      show('assets-page');document.getElementById('subscriptions-view').classList.add('hidden');assets.render();
                      window.financePhase2.refreshAssets=()=>assets.render();
                      window.financePhase2.showAssets=()=>{show('assets-page');assets.render();};
                      window.financePhase2.showCosts=()=>{show('subscriptions-view');subs.render();};
                      window.financePhase2.resetCosts=()=>subs.reset();
                      window.financePhase2.resetAssets=()=>assets.reset();
                      window.financePhase2.showRates=()=>{
                        data.cardPreferences={'rakuten-mizuho':{pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:future,ratePercent:1}]}};
                        show('settings-view');document.querySelector('.settings-card-disclosure').open=true;initCardSettings(()=>vault,()=>{});
                      };
                    }''')
                    self.assertEqual(page.locator('#assets-recurring-kind option').evaluate_all('xs=>xs.map(x=>x.value)'),['income','transfer'])
                    self.assertIn('定期入金テスト',page.locator('#assets-recurring-list').inner_text())
                    self.assertNotIn('銀行固定費テスト',page.locator('#assets-recurring-list').inner_text())
                    self.assertEqual(page.locator('#assets-fixed-cost-list, #assets-fixed-cost-open, .assets-reconcile-shared').count(),0)
                    fields=page.locator('.recurring-account-row').evaluate('e=>({tracks:getComputedStyle(e).gridTemplateColumns.split(" ").length,amount:e.querySelector("#assets-recurring-amount").getBoundingClientRect().width,to:e.querySelector("#assets-recurring-to").getBoundingClientRect().width})')
                    self.assertLessEqual(fields['tracks'],2)
                    self.assertGreater(fields['amount'],0);self.assertAlmostEqual(fields['amount'],fields['to'],delta=3)
                    page.evaluate('window.financePhase2.showCosts()')
                    page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト').get_by_role('button',name='詳細・編集').click()
                    detail=page.locator('.fixed-cost-dialog')
                    self.assertTrue(detail.evaluate("d=>d.classList.contains('finance-modal')&&getComputedStyle(d).borderRadius==='14px'&&d.querySelector('.finance-modal-head .finance-modal-x').textContent==='×'"))
                    self.assertIn('次回支払予定',detail.inner_text())
                    self.assertIn('適用予定',detail.inner_text())
                    form=page.locator('.fixed-cost-form');visible=lambda:form.locator('.fixed-cost-field:visible [name]').evaluate_all('xs=>xs.map(x=>x.name)')
                    self.assertEqual(visible(),['name','amount','method','accountId','category','frequency','startOn','day','priceAction','status','note'])
                    self.assertTrue(form.locator('[name="startOn"]').evaluate('e=>e.readOnly'));self.assertTrue(form.get_by_role('button',name='保存',exact=True).is_disabled())
                    form.locator('[name="note"]').fill('更新したメモ')
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===1')
                    saved=page.evaluate('window.financePhase2.writes[0].entry')
                    self.assertEqual(saved['note'],'更新したメモ');self.assertEqual(saved['amount'],1300)
                    self.assertEqual([x['amount'] for x in saved['pricing']],[1000,1300]);self.assertEqual(saved['fromAccountId'],'rakuten-bank')
                    page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト').get_by_role('button',name='詳細・編集').click()
                    form.locator('[name="priceAction"]').select_option('revise')
                    form.locator('[name="amount"]').fill('1500')
                    form.locator('[name="paymentDate"]').fill(page.evaluate('window.financePhase2.future'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===2')
                    self.assertEqual(page.evaluate('window.financePhase2.writes[1].entry.pricing.map(x=>x.amount)'),[1000,1500])
                    page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト').get_by_role('button',name='詳細・編集').click()
                    form.locator('[name="status"]').select_option('paused')
                    form.locator('[name="statusDate"]').fill(page.evaluate('window.financePhase2.future'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===3')
                    self.assertEqual(page.evaluate('window.financePhase2.writes[2].entry.pauses.length'),1)
                    page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト').get_by_role('button',name='詳細・編集').click()
                    status_history=detail.locator('.fixed-cost-status-history')
                    self.assertEqual(status_history.locator('summary').inner_text(),'契約状態の履歴')
                    self.assertEqual(status_history.evaluate('e=>getComputedStyle(e).borderTopWidth'),'0px')
                    status_history.locator('summary').click()
                    self.assertIn('停止期間',status_history.inner_text())
                    self.assertTrue(status_history.locator('.fixed-cost-detail-line').evaluate_all('xs=>xs.every(e=>getComputedStyle(e).borderBottomWidth==="0px")'))
                    self.assertTrue(detail.get_by_role('button',name='削除',exact=True).is_visible())
                    detail.get_by_role('button',name='閉じる',exact=True).click()
                    page.get_by_role('button',name='＋ 新規登録').click()
                    geometry=form.evaluate("""e=>{const box=n=>e.querySelector(`[name=${n}]`).closest('label').getBoundingClientRect(),r=n=>e.querySelector(`[name=${n}]`).getBoundingClientRect();const names=['amount','method','cardId','merchant','category','frequency','startOn','day'];const a=Object.fromEntries(names.map(n=>[n,{x:box(n).x,y:box(n).y,w:box(n).width}]));const p=e.querySelector('.fixed-cost-price-choices').getBoundingClientRect();return {a,p:{x:p.x,y:p.y,w:p.width},overflow:e.scrollWidth-e.clientWidth,selectArrow:getComputedStyle(e.querySelector('[name=method]')).backgroundImage,selectHeight:r('method').height}}""")
                    self.assertLessEqual(geometry['overflow'],2);self.assertIn('svg',geometry['selectArrow'])
                    self.assertTrue(form.locator('select:visible').evaluate_all("xs=>xs.every(x=>getComputedStyle(x).textAlign==='left'&&getComputedStyle(x).textAlignLast==='left')"))
                    if width==1100:
                        a=geometry['a'];p=geometry['p']
                        for row in [('amount','method','cardId'),('frequency','startOn','day')]:
                            self.assertLessEqual(max(a[n]['y'] for n in row)-min(a[n]['y'] for n in row),2)
                            self.assertEqual(sorted(row,key=lambda n:a[n]['x']),list(row))
                        self.assertAlmostEqual(p['w'],a['cardId']['w'],delta=2)
                        self.assertAlmostEqual(p['y'],a['merchant']['y'],delta=2)
                        self.assertGreater(p['x'],a['merchant']['x'])
                        self.assertGreater(a['merchant']['w'],p['w'])
                    else:
                        self.assertLess(geometry['a']['amount']['y'],geometry['a']['method']['y'])
                    self.assertNotIn('category',visible())
                    self.assertTrue(form.locator('[name=category]').is_disabled())
                    self.assertTrue(form.get_by_role('radio',name='固定額',exact=True).is_checked())
                    self.assertTrue(form.locator('.fixed-cost-price-choice').evaluate_all("xs=>xs.every(x=>getComputedStyle(x).justifyContent==='flex-start')"))
                    form.get_by_role('radio',name='変動額',exact=True).check();self.assertEqual(form.locator('[name="priceKind"]').input_value(),'variable')
                    self.assertNotIn('priceDate',visible());self.assertNotIn('statusDate',visible());self.assertNotIn('status',visible())
                    form.locator('[name="method"]').select_option('cash')
                    self.assertNotIn('cardId',visible());self.assertNotIn('accountId',visible());self.assertIn('category',visible())
                    form.locator('[name=category]').select_option('food')
                    form.locator('[name="method"]').select_option('bank')
                    self.assertIn('accountId',visible());self.assertNotIn('cardId',visible());self.assertIn('category',visible())
                    form.locator('[name="method"]').select_option('card')
                    self.assertIn('cardId',visible());self.assertNotIn('accountId',visible());self.assertNotIn('category',visible())
                    form.locator('[name="name"]').fill('年払いテスト')
                    form.locator('[name="amount"]').fill('21300');form.locator('[name="frequency"]').select_option('yearly')
                    self.assertIn('month',visible());self.assertIn('1,775円',form.inner_text())
                    self.assertTrue(form.evaluate('e=>e.scrollWidth<=e.clientWidth+2'))
                    form.locator('[name="startOn"]').fill(page.evaluate('window.financePhase2.future'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===4')
                    new=page.evaluate('window.financePhase2.writes[3].entry')
                    self.assertEqual(new['pricing'],[{'effectiveOn':new['startOn'],'amount':21300}])
                    self.assertEqual(new['priceKind'],'variable');self.assertEqual(new['pauses'],[]);self.assertIsNone(new['endOn']);self.assertIsNone(new['categoryId'])
                    # Change a bank contract to a card today, then schedule a later cash change.
                    cost=page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト')
                    cost.get_by_role('button',name='詳細・編集').click()
                    self.assertIn('amount',visible());self.assertIn('name',visible());self.assertNotIn('paymentDate',visible())
                    form.locator('[name="method"]').select_option('card')
                    self.assertIn('cardId',visible());self.assertNotIn('accountId',visible())
                    form.locator('[name="cardId"]').select_option('smbc-nl');form.locator('[name="merchant"]').fill('SYNTHETIC SERVICE');form.locator('[name="note"]').fill('同時変更')
                    form.locator('[name="paymentDate"]').fill(page.evaluate('window.financePhase2.today'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===5')
                    changed=page.evaluate('window.financePhase2.writes[4].entry')
                    self.assertEqual(changed['id'],'bank-cost-demo');self.assertEqual(changed['fromAccountId'],'rakuten-bank');self.assertEqual(changed['categoryId'],'food')
                    self.assertEqual([x['payment'] for x in changed['paymentHistory']],['bank','card']);self.assertEqual(changed['pricing'][-1]['amount'],1500);self.assertEqual(changed['note'],'同時変更')
                    page.evaluate('window.financePhase2.refreshAssets()')
                    self.assertNotIn('銀行固定費テスト',page.locator('#assets-recurring-list').text_content())
                    cost.get_by_role('button',name='詳細・編集').click()
                    detail.get_by_text('支払条件の変更履歴',exact=True).click()
                    self.assertIn('現在適用中',detail.inner_text());self.assertIn('過去の条件',detail.inner_text())
                    self.assertEqual(form.locator('[name="method"]').input_value(),'card')
                    form.locator('[name="method"]').select_option('cash');form.locator('[name="paymentDate"]').fill(page.evaluate('window.financePhase2.future'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===6')
                    cost.get_by_role('button',name='詳細・編集').click()
                    self.assertEqual(detail.locator('.fixed-cost-payment-history').count(),3)
                    detail.get_by_text('支払条件の変更履歴',exact=True).click()
                    self.assertIn('適用予定',detail.inner_text());self.assertIn('現金',detail.inner_text())
                    detail.get_by_role('button',name='閉じる',exact=True).click()
                    # Existing card contract with a future bank route stays one contract.
                    annual=page.locator('.fixed-cost-item').filter(has_text='年払いテスト')
                    annual.get_by_role('button',name='詳細・編集').click()
                    form.locator('[name="method"]').select_option('bank');self.assertIn('accountId',visible())
                    form.locator('[name="accountId"]').select_option('mizuho-bank')
                    # Explicitly schedule a change AFTER the contract starts; the default
                    # start date now corrects the initial terms instead of appending history.
                    form.locator('[name="paymentDate"]').fill(page.evaluate("new Date(Date.parse(window.financePhase2.future+'T00:00:00Z')+86400000).toISOString().slice(0,10)"))
                    form.get_by_role('button',name='保存',exact=True).click();page.wait_for_function('window.financePhase2.writes.length===7')
                    self.assertEqual(page.evaluate('window.financePhase2.writes[6].entry.paymentHistory.map(x=>x.payment)'),['card','bank'])
                    self.assertEqual(page.evaluate('window.financePhase2.data.fixedCosts.length'),1)
                    # The settings show current and scheduled rates without saving anything.
                    page.evaluate('window.financePhase2.showRates()')
                    page.locator('input[name="card-setting-selected"][value="rakuten-mizuho"]').check()
                    self.assertEqual(page.locator('.card-setting-rate-history').count(),0)
                    history=page.locator('.card-setting-rate-history-list:visible');history.locator('summary').click()
                    self.assertIn('適用予定',history.inner_text());self.assertIn('1.0%',history.inner_text());self.assertIn('現在適用中',history.inner_text());self.assertIn('2.0%',history.inner_text())
                    rate_edit=page.locator('.card-setting-rate-edit:visible');self.assertTrue(rate_edit.locator('input').first.is_visible());self.assertEqual(rate_edit.locator('summary').count(),0)
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),7)
                    # A changed draft must survive Escape/cancel and backdrop dismissal.
                    page.evaluate('window.financePhase2.showCosts()')
                    annual.get_by_role('button',name='詳細・編集').click()
                    form.locator('[name="note"]').fill('未保存の編集')
                    detail.get_by_role('button',name='閉じる',exact=True).click()
                    confirmation=page.locator('.finance-confirm-dialog')
                    self.assertIn('未保存の変更',confirmation.inner_text())
                    confirmation.get_by_role('button',name='編集を続ける').click()
                    self.assertEqual(form.locator('[name="note"]').input_value(),'未保存の編集')
                    self.assertEqual(detail.locator('form').count(),1)
                    self.assertEqual(detail.get_by_role('button',name='閉じる',exact=True).count(),1)
                    page.keyboard.press('Escape');confirmation.wait_for()
                    page.keyboard.press('Escape');confirmation.wait_for(state='detached')
                    self.assertTrue(form.is_visible())
                    form.get_by_role('button',name='変更をクリア',exact=True).click()
                    confirmation.get_by_role('button',name='クリアする').click()
                    self.assertTrue(form.is_visible());self.assertEqual(form.locator('[name="note"]').input_value(),'');self.assertTrue(form.get_by_role('button',name='保存',exact=True).is_disabled())
                    detail.get_by_role('button',name='閉じる',exact=True).click()
                    # A record updated during an open confirmation must not be deleted.
                    annual.get_by_role('button',name='詳細・編集').click()
                    detail.get_by_role('button',name='削除',exact=True).click()
                    self.assertIn('カードの請求明細は削除されません',confirmation.inner_text())
                    page.evaluate("window.financePhase2.data.fixedCosts[0].note='別端末の変更'")
                    confirmation.get_by_role('button',name='削除する').click()
                    self.assertIn('契約が更新されました',form.locator('.fixed-cost-form-error').inner_text())
                    detail.get_by_role('button',name='閉じる',exact=True).click()
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),7)
                    annual.get_by_role('button',name='詳細・編集').click()
                    detail.get_by_role('button',name='削除',exact=True).click()
                    confirmation.get_by_role('button',name='キャンセル').click()
                    self.assertTrue(detail.is_visible())
                    detail.get_by_role('button',name='削除',exact=True).click()
                    page.evaluate('window.financePhase2.resetCosts()')
                    confirmation.wait_for(state='detached');detail.wait_for(state='hidden')
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),7)
                    page.evaluate('window.financePhase2.showCosts()')
                    annual.get_by_role('button',name='詳細・編集').click()
                    detail.get_by_role('button',name='削除',exact=True).click()
                    confirmation.get_by_role('button',name='削除する').click()
                    page.wait_for_function('window.financePhase2.writes.length===8')
                    self.assertEqual(page.evaluate('window.financePhase2.writes[7].type'),'delete-contract')
                    # The once editor uses the same changed-only guard and releases the page lock.
                    page.evaluate('window.financePhase2.showAssets()')
                    page.locator('#assets-once-add').click()
                    once=page.locator('#assets-once-dialog');once.locator('#assets-once-name').fill('単発テスト')
                    once.locator('#assets-once-amount').fill('1000')
                    once.locator('#assets-once-close').click();confirmation.wait_for()
                    confirmation.get_by_role('button',name='編集を続ける').click()
                    self.assertEqual(once.locator('#assets-once-name').input_value(),'単発テスト')
                    self.assertTrue(page.evaluate("document.documentElement.classList.contains('assets-once-page-locked')"))
                    once.locator('#assets-once-save').click();page.wait_for_function('window.financePhase2.writes.length===9')
                    once.wait_for(state='hidden');page.wait_for_function("!document.documentElement.classList.contains('assets-once-page-locked')")
                    item=page.locator('.assets-once-item').filter(has_text='単発テスト')
                    item.get_by_role('button',name='削除').click()
                    page.evaluate('window.financePhase2.data.oneTime[0].amount=2000')
                    confirmation.get_by_role('button',name='削除する').click()
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),9)
                    page.evaluate('window.financePhase2.refreshAssets()')
                    item.get_by_role('button',name='削除').click();confirmation.get_by_role('button',name='削除する').click()
                    page.wait_for_function('window.financePhase2.writes.length===10')
                    self.assertEqual(page.evaluate('window.financePhase2.writes[9].type'),'delete-once')
                    page.locator('#assets-once-add').click();once.locator('#assets-once-name').fill('未保存')
                    once.locator('#assets-once-cancel').click();confirmation.wait_for()
                    page.evaluate('window.financePhase2.resetAssets()');confirmation.wait_for(state='detached')
                    once.wait_for(state='hidden');page.wait_for_function("!document.documentElement.classList.contains('assets-once-page-locked')")
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),10)
                    # The newest future route can be corrected, then cancelled with approval.
                    page.evaluate('window.financePhase2.showCosts()');cost.get_by_role('button',name='詳細・編集').click()
                    self.assertIn('次回支払予定',detail.inner_text());self.assertIn('1,500円',detail.inner_text())
                    form.locator('[name="paymentAction"]').select_option('revise')
                    self.assertEqual(form.locator('[name="method"]').input_value(),'cash')
                    form.locator('[name="method"]').select_option('bank');form.locator('[name="accountId"]').select_option('mizuho-bank')
                    form.get_by_role('button',name='保存',exact=True).click();page.wait_for_function('window.financePhase2.writes.length===11')
                    cost.get_by_role('button',name='詳細・編集').click();form.locator('[name="paymentAction"]').select_option('cancel')
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),11)
                    form.get_by_role('button',name='保存',exact=True).click();confirmation.get_by_role('button',name='キャンセル').click()
                    self.assertEqual(page.evaluate('window.financePhase2.writes.length'),11)
                    form.get_by_role('button',name='保存',exact=True).click();confirmation.get_by_role('button',name='保存する').click()
                    page.wait_for_function('window.financePhase2.writes.length===12');self.assertEqual(page.evaluate('window.financePhase2.writes.at(-1).entry.paymentHistory.map(x=>x.payment)'),['bank','card'])
                    cost.get_by_role('button',name='詳細・編集').click();form.locator('[name="priceAction"]').select_option('cancel')
                    self.assertTrue(form.locator('[name="amount"]').is_disabled());self.assertEqual(page.evaluate('window.financePhase2.writes.length'),12)
                    form.get_by_role('button',name='保存',exact=True).click();confirmation.get_by_role('button',name='保存する').click()
                    page.wait_for_function('window.financePhase2.writes.length===13');self.assertEqual(page.evaluate('window.financePhase2.writes.at(-1).entry.amount'),1000)
                    page.evaluate('window.financePhase2.showAssets()');self.assertIn('定期入金テスト',page.locator('#assets-recurring-list').text_content())
                    page.evaluate('window.financePhase2.lock()');self.assertEqual(page.locator('#assets-recurring-list').text_content(),'')
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_ordinary_confirmations_preserve_drafts_and_targets(self):
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(390,640,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {initMonthlySummary}=await import('finance-fixture/ui/monthly-summary.js');
                      const date=new Date(),month=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                      const current=month(date),previous=month(new Date(date.getFullYear(),date.getMonth()-1,1));
                      const before=month(new Date(date.getFullYear(),date.getMonth()-2,1));
                      const data=emptyAssets(),writes=[];
                      data.recurring=['A','B'].map((key,i)=>({id:'income-'+key,kind:'income',name:'定期入金'+key,amount:1000+i,
                        fromAccountId:null,toAccountId:'rakuten-bank',frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,
                        startOn:before+'-01',endOn:null,categoryId:null,enabled:true}));
                      data.snapshots=[{id:'balance-a',accountId:'rakuten-bank',balance:10000,observedAt:before+'-01T00:00:00Z'}];
                      data.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:true};data.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
                      const bill={id:'bill-previous',statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',
                        paymentDate:previous+'-27',billingMonth:before,statedTotal:1000,confirmation:'confirmed',warnings:[],rows:[{id:'row-a',usedOn:before+'-08',merchant:'SAMPLE',amount:1000}]}};
                      const records=[bill];const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>structuredClone(records),
                        async deleteRecurring(id){writes.push(['recurring',id]);data.recurring=data.recurring.filter(x=>x.id!==id);},
                        async deleteBalanceSnapshot(id){writes.push(['balance',id]);data.snapshots=data.snapshots.filter(x=>x.id!==id);}};
                      const source=()=>vault.unlocked?{assets:vault.assetSettings(),records:vault.readonlyRecords(),rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}}:null;
                      const assets=initAssetsSettings(()=>vault,()=>[],()=>{});
                      const home=initHome({source,navigate(){},async saveMizuhoFunding(m,done,snapshot){if(window.ordinary.failFunding)await new Promise((_,reject)=>{window.ordinary.rejectFunding=()=>reject(new Error('Microsoft認証が時間内に完了しませんでした。設定の「再認証」をお試しください。'));});writes.push(['funding',m,done]);data.mizuhoFundingChecks={...data.mizuhoFundingChecks,[m]:{done,updatedAt:new Date().toISOString(),...snapshot}};}});
                      const summary=initMonthlySummary({source,openRecord(){},openDrilldown(){},async saveCardNoUseMonth(m,yes){writes.push(['no-use',m,yes]);const months=new Set(data.cardNoUseMonths??[]);if(yes)months.add(m);else months.delete(m);data.cardNoUseMonths=[...months];}});
                      const show=id=>{for(const node of document.querySelectorAll('.workspace .content>section'))node.classList.toggle('hidden',node.id!==id);document.getElementById(id).classList.remove('hidden');};
                      window.ordinary={data,writes,bill,records,current,previous,assets,home,summary,showAssets(){show('assets-page');assets.render();home.renderFundingHistory();},showHome(){show('home-view');home.render();},showSummary(){show('summary-view');summary.setPeriod(current);}};
                      window.ordinary.showAssets();
                    }''')
                    confirm=page.locator('.finance-confirm-dialog')
                    names=page.locator('#assets-recurring-name');rows=page.locator('#assets-recurring-list .assets-recurring-item')
                    # Switching and clearing must preserve actual changed fields on cancel.
                    first=rows.filter(has_text='定期入金A');second=rows.filter(has_text='定期入金B')
                    first.get_by_role('button',name='編集').click();names.fill('未保存の入力')
                    second.get_by_role('button',name='編集').click();confirm.get_by_role('button',name='編集を続ける').click()
                    self.assertEqual(names.input_value(),'未保存の入力')
                    page.locator('#assets-recurring-clear').click();page.keyboard.press('Escape');confirm.wait_for(state='detached')
                    self.assertEqual(names.input_value(),'未保存の入力')
                    second.get_by_role('button',name='編集').click();confirm.get_by_role('button',name='破棄して開く').click()
                    self.assertEqual(names.input_value(),'定期入金B')
                    names.fill('別の未保存');page.locator('#assets-recurring-clear').click()
                    confirm.get_by_role('button',name='破棄する').click();self.assertEqual(names.input_value(),'')
                    # Record changed during confirmation: don't delete even with approval.
                    second.get_by_role('button',name='削除').click()
                    page.evaluate('window.ordinary.data.recurring[1].amount=9000')
                    confirm.get_by_role('button',name='削除する').click()
                    self.assertEqual(page.evaluate('window.ordinary.writes.length'),0)
                    page.evaluate('window.ordinary.assets.render()')
                    second.get_by_role('button',name='削除').click();confirm.get_by_role('button',name='削除する').click()
                    page.wait_for_function('window.ordinary.writes.length===1')
                    # Snapshot identity and amount remain bound to the action.
                    history=page.locator('.assets-account-card').filter(has=page.get_by_role('heading',name='楽天銀行',exact=True)).locator('.assets-history')
                    history.locator('summary').click();history.get_by_role('button',name='削除').click()
                    page.evaluate('window.ordinary.data.snapshots[0].balance=20000')
                    confirm.get_by_role('button',name='削除する').click();self.assertEqual(page.evaluate('window.ordinary.writes.length'),1)
                    page.evaluate('window.ordinary.assets.render()')
                    history.get_by_role('button',name='削除').click();confirm.get_by_role('button',name='削除する').click()
                    page.wait_for_function('window.ordinary.writes.length===2')
                    # Prior-month funding is available regardless of the current day.
                    page.evaluate('window.ordinary.showHome()');funding=page.locator('.home-funding-save:enabled')
                    self.assertIn('期限超過',page.locator('.home-funding-prior').inner_text())
                    self.assertEqual(funding.inner_text(),'送金済み')
                    page.evaluate("window.ordinary.bill.statement.confirmation='provisional';window.ordinary.home.render()")
                    self.assertIn('明細確定待ち',page.locator('.home-funding-prior').inner_text())
                    self.assertTrue(page.locator('.home-funding-prior .home-funding-review').is_visible())
                    self.assertEqual(page.locator('.home-funding-prior .home-funding-save').count(),0)
                    page.evaluate("window.ordinary.bill.statement.confirmation='confirmed';window.ordinary.home.render()")
                    funding.click();page.evaluate('window.ordinary.bill.statement.rows[0].amount=2000;window.ordinary.bill.statement.statedTotal=2000')
                    confirm.get_by_role('button',name='はい',exact=True).click();self.assertEqual(page.evaluate('window.ordinary.writes.length'),2)
                    # A failed authentication leaves the exact same action available and uses the shared activity toast.
                    page.evaluate('window.ordinary.failFunding=true');funding.click()
                    previous=page.evaluate('window.ordinary.previous');year,month=previous.split('-')
                    self.assertIn(f'{year}年{int(month)}月分',confirm.locator('.finance-confirm-message').inner_text())
                    self.assertIn(f'支払日：{year}/{month}/27',confirm.locator('.finance-confirm-message').inner_text())
                    self.assertNotIn(previous,confirm.locator('.finance-confirm-message').inner_text())
                    confirm.get_by_role('button',name='キャンセル').click()
                    self.assertEqual(page.evaluate('window.ordinary.writes.length'),2)
                    funding.click();confirm.get_by_role('button',name='はい',exact=True).click()
                    page.wait_for_function('typeof ordinary.rejectFunding==="function"')
                    toast=page.locator('#toast');self.assertEqual(toast.get_attribute('data-kind'),'working')
                    self.assertTrue(toast.evaluate("e=>e.classList.contains('visible')"))
                    page.evaluate('ordinary.rejectFunding()');page.wait_for_function("document.getElementById('toast').dataset.kind==='bad'")
                    self.assertIn('再認証',toast.inner_text());self.assertTrue(funding.is_enabled())
                    self.assertEqual(page.evaluate('window.ordinary.writes.length'),2)
                    page.evaluate('window.ordinary.failFunding=false')
                    funding.click();confirm.get_by_role('button',name='はい',exact=True).click()
                    page.wait_for_function('window.ordinary.writes.length===3')
                    self.assertEqual(page.evaluate('window.ordinary.writes.at(-1)'),['funding',page.evaluate('window.ordinary.previous'),True])
                    self.assertEqual(toast.get_attribute('data-kind'),'good')
                    self.assertIn('送金済みとして記録しました',toast.inner_text())
                    self.assertEqual(page.locator('#home-content > .home-funding').count(),0)
                    self.assertEqual(page.locator('#home-content .home-funding-revoke').count(),0)
                    page.evaluate('window.ordinary.showAssets()')
                    completed=page.locator('#assets-funding-history-panel')
                    self.assertFalse(completed.locator('.home-funding-revoke').is_visible())
                    completed.locator('summary').click()
                    revoke=completed.get_by_role('button',name='確認を取り消す')
                    self.assertTrue(revoke.is_visible())
                    revoke.click();confirm.get_by_role('button',name='キャンセル').click()
                    self.assertEqual(page.evaluate('window.ordinary.writes.length'),3)
                    # A real cancellation from accounts must restore the home reminder.
                    revoke.click();confirm.get_by_role('button',name='取り消す',exact=True).click()
                    page.wait_for_function('window.ordinary.writes.length===4')
                    self.assertFalse(completed.is_visible())
                    page.evaluate('window.ordinary.showHome()')
                    self.assertTrue(page.locator('#home-content .home-funding-prior .home-funding-save').is_visible())
                    # No-use approval belongs to the originally displayed month, never another month.
                    page.evaluate('window.ordinary.showSummary()');noUse=page.get_by_role('button',name='この月はカード利用なしと確認')
                    noUse.click();page.evaluate('window.ordinary.summary.setPeriod(window.ordinary.previous)')
                    confirm.get_by_role('button',name='確認を記録').click();self.assertEqual(page.evaluate('window.ordinary.writes.length'),4)
                    page.evaluate('window.ordinary.showSummary()');noUse.click();page.evaluate('window.ordinary.summary.reset()')
                    confirm.wait_for(state='detached');self.assertEqual(page.evaluate('window.ordinary.writes.length'),4)
                    page.evaluate('window.ordinary.showSummary()');noUse.click();confirm.get_by_role('button',name='確認を記録').click()
                    page.wait_for_function('window.ordinary.writes.length===5')
                    page.get_by_role('button',name='「カード利用なし」を取り消す').click();confirm.get_by_role('button',name='取り消す').click()
                    page.wait_for_function('window.ordinary.writes.length===6')
                    self.assertEqual(page.evaluate('window.ordinary.writes.slice(-2)'),[['no-use',page.evaluate('window.ordinary.current'),True],['no-use',page.evaluate('window.ordinary.current'),False]])
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_home_funding_start_and_empty_checklist(self):
        from datetime import datetime, timezone
        from playwright.sync_api import expect
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile,timezone_id='Asia/Tokyo')
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.clock.set_fixed_time(datetime(2026,11,11,3,tzinfo=timezone.utc))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const assets=emptyAssets();assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:true};assets.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
                      const source={records:[],rules:[],categories:[],assets,payroll:{ready:true,syncedAt:1000,entries:[]}};
                      for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!=='home-view');
                      const home=initHome({source:()=>source,navigate(){}});home.render();
                      window.checklist={home,source};
                    }''')
                    home=page.locator('#home-content')
                    checklist=home.locator('.home-section').filter(has=page.get_by_role('heading',name='確認すること',exact=True))
                    expect(checklist).to_be_visible();expect(checklist).to_contain_text('現在、確認することはありません。')
                    expect(checklist.locator('.home-funding')).to_have_count(0)
                    page.clock.set_fixed_time(datetime(2026,11,12,3,tzinfo=timezone.utc));page.evaluate('checklist.home.render()')
                    expect(checklist.locator('.home-funding')).to_be_visible();expect(checklist).to_contain_text('明細確定待ち')
                    expect(checklist).not_to_contain_text('現在、確認することはありません。')
                    page.evaluate('checklist.source.payroll.ready=false;checklist.home.render()');expect(checklist).to_contain_text('Payrollの同期を確認')
                    self.assertFalse(errors,errors)
                finally:context.close()

    def test_month_end_and_actual_funding_entry(self):
        from datetime import datetime, timezone
        from playwright.sync_api import expect
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile,timezone_id='Asia/Tokyo')
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.clock.set_fixed_time(datetime(2026,11,26,3,tzinfo=timezone.utc))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,validateOneTime}=await import('finance-fixture/cloud/assets.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      let id=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`synthetic-funding-${++id}`});
                      const data=emptyAssets();data.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:true};data.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};
                      data.snapshots=[{id:'rak-snapshot',accountId:'rakuten-bank',balance:100000,observedAt:'2026-11-25T00:00:00Z'},{id:'miz-snapshot',accountId:'mizuho-bank',balance:0,observedAt:'2026-11-23T00:00:00Z'}];
                      const records=[{id:'sample-invoice',statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:'2026-11',paymentDate:'2026-11-27',statedTotal:24245,confirmation:'confirmed',warnings:[],rows:[{id:'row-sample',usedOn:'2026-10-10',merchant:'SAMPLE',amount:24245}]}}];
                      const writes=[];let fail=false;
                      const source={records,rules:[],categories:[],assets:data,payroll:{ready:false,syncedAt:null,entries:[]}};
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>records,
                        async upsertOneTime(entry,snapshot){if(fail)throw Error('synthetic write failure');const valid=validateOneTime(entry);data.oneTime=(data.oneTime??[]).filter(e=>e.id!==valid.id).concat(valid);writes.push({entry:valid,snapshot});}};
                      const show=id=>{for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!==id);};
                      const ui=initAssetsSettings(()=>vault,()=>[],()=>{});ui.render();
                      const home=initHome({source:()=>source,navigate(){},openFundingMovement(snapshot){show('assets-page');ui.render();ui.openFundingMovement(snapshot);}});
                      const showHome=()=>{show('home-view');home.render();};showHome();
                      window.fundingActual={showHome,data,writes,fail:()=>{fail=true},recover:()=>{fail=false}};
                    }''')
                    home=page.locator('#home-content');month_end=home.locator('.home-month-end')
                    expect(month_end).to_contain_text('月末の銀行残高見込み')
                    home.get_by_role('button',name='実際の送金を記録・編集').click()
                    dialog=page.locator('#assets-once-dialog');expect(dialog).to_be_visible()
                    expect(dialog.locator('#assets-once-date')).to_have_value('2026-11-26')
                    expect(dialog.locator('#assets-once-amount')).to_have_value('')
                    expect(dialog.locator('#assets-once-funding')).to_be_checked()
                    expect(dialog.locator('#assets-once-to')).to_have_value('mizuho-bank')
                    dialog.locator('#assets-once-cancel').click();expect(dialog).not_to_be_visible()
                    self.assertEqual(page.evaluate('fundingActual.writes.length'),0)
                    page.evaluate('fundingActual.showHome()');home.get_by_role('button',name='実際の送金を記録・編集').click()
                    dialog.locator('#assets-once-amount').fill('28000')
                    page.evaluate('fundingActual.fail()');dialog.locator('#assets-once-save').click()
                    expect(dialog.locator('#assets-once-error')).to_contain_text('synthetic write failure')
                    expect(dialog.locator('#assets-once-amount')).to_have_value('28000')
                    expect(dialog.locator('#assets-once-save')).to_be_enabled()
                    page.evaluate('fundingActual.recover()');dialog.locator('#assets-once-save').click()
                    expect(dialog).not_to_be_visible();self.assertEqual(page.evaluate('fundingActual.writes.length'),1)
                    self.assertEqual(page.evaluate('fundingActual.writes[0].entry.amount'),28000)
                    self.assertEqual(page.evaluate('fundingActual.writes[0].snapshot.billId'),'sample-invoice')
                    page.evaluate('fundingActual.showHome()');expect(month_end).to_contain_text('75,755円');expect(month_end).to_contain_text('72,000円');expect(month_end).to_contain_text('3,755円')
                    self.assertTrue(month_end.evaluate('el=>el.scrollWidth<=el.clientWidth+1'))
                    home.get_by_role('button',name='実際の送金を記録・編集').click()
                    expect(dialog.locator('#assets-once-amount')).to_have_value('28000')
                    dialog.locator('#assets-once-cancel').click();expect(dialog).not_to_be_visible()
                    self.assertEqual(page.evaluate('fundingActual.writes.length'),1)
                    self.assertFalse(errors,errors)
                finally:context.close()

    def test_import_and_category_confirmation_modal_paths(self):
        # Execute the shipped main.js handlers without starting Microsoft authentication.
        js=(ROOT/'dist/src/main.js').read_text(encoding='utf-8')
        def block(start,end):
            first=js.index(start);return js[first:js.index(end,first+len(start))]
        handlers=(block('function updateImportUploadFeedback(', 'function buildStatementList(')+
                  block('async function closeCategoryDialog(', 'async function saveCategoryDialog(')+
                  block('function confirmStatementRevision(', '/** CSV is structurally valid')+
                  block('const dismissImportAdd = async', "$('import-add-close').addEventListener"))
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(390,640,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {bindModalDismiss,requestConfirmation,confirmationPending}=await import('finance-fixture/ui/modal.js');
                      const {formatYen:yen,formatMonth}=await import('finance-fixture/ui/formatters.js');
                      const $=id=>document.getElementById(id),ordinaryConfirmationOwner={},liveVault={unlocked:true};
                      let filesBusy=false,revisionBusy=false,batchBusy=false,categorySaving=false,lockSequence=0;
                      let clipboardHtml='',importUploadFeedback='',currentUploadFailures=[];
                      let categoryDraft=[{id:'demo',name:'変更後'}],categoryBaseline=[];
                      const categoryPlan=()=>({}),categoryBatchChanged=()=>true,cardDisplayName=()=> 'テストカード';
                    '''+handlers+'''
                      $('import-add-close').addEventListener('click',dismissImportAdd);
                      bindModalDismiss($('import-add-dialog'),dismissImportAdd);
                      $('categories-dialog-close').addEventListener('click',closeCategoryDialog);
                      bindModalDismiss($('categories-dialog'),closeCategoryDialog);
                      $('import-view').classList.remove('hidden');$('import-view').classList.add('import-compact');
                      const row={id:'row-test',usedOn:'2026-01-01',merchant:'SAMPLE',amount:1000};
                      const old={sourceKind:'pdf',cardId:'smbc-nl',billingMonth:'2026-01',statedTotal:1000,rows:[row]};
                      const incoming={...old,sourceKind:'csv'};
                      const diff={matched:0,added:[row],removed:[],changed:[],ambiguous:[],transferred:0,notesTransferred:0,overridesLost:[row]};
                      const results=[];
                      window.ordinaryDialogs={results,openImport:openImportAddDialog,
                        openCategory(){categoryDraft=[{id:'demo',name:'変更後'}];$('categories-dialog').showModal();},
                        category:()=>categoryDraft,
                        revision(){void confirmStatementRevision(old,incoming,diff).then(x=>results.push(x));}};
                    }''')
                    confirm=page.locator('.finance-confirm-dialog')
                    page.evaluate('window.ordinaryDialogs.openImport()')
                    add=page.locator('#import-add-dialog');page.locator('#paste-pane').evaluate('x=>x.open=true')
                    pasted=page.locator('#paste-input');pasted.fill('未解析のテスト明細')
                    add.get_by_role('button',name='閉じる').click();confirm.get_by_role('button',name='編集を続ける').click()
                    self.assertEqual(pasted.input_value(),'未解析のテスト明細')
                    page.keyboard.press('Escape');confirm.get_by_role('button',name='破棄する').click()
                    add.wait_for(state='hidden');self.assertEqual(pasted.input_value(),'')
                    page.evaluate('window.ordinaryDialogs.openCategory()');category=page.locator('#categories-dialog')
                    category.get_by_role('button',name='閉じる').click();confirm.get_by_role('button',name='編集を続ける').click()
                    self.assertTrue(category.is_visible());self.assertEqual(page.evaluate('window.ordinaryDialogs.category()[0].name'),'変更後')
                    page.keyboard.press('Escape');confirm.get_by_role('button',name='破棄する').click();category.wait_for(state='hidden')
                    self.assertIsNone(page.evaluate('window.ordinaryDialogs.category()'))
                    revision=page.locator('#import-revision-dialog');accept=page.locator('#import-revision-accept')
                    for step,action in enumerate(('escape','close','force','accept'),1):
                        page.evaluate('window.ordinaryDialogs.revision()');revision.wait_for()
                        self.assertTrue(accept.is_disabled());self.assertIn('SAMPLE',revision.inner_text())
                        self.assertIn('2026年1月分',revision.locator('#import-revision-summary').inner_text())
                        self.assertNotIn('2026-01分',revision.locator('#import-revision-summary').inner_text())
                        if action=='escape':page.keyboard.press('Escape')
                        elif action=='close':revision.get_by_role('button',name='閉じる').click()
                        elif action=='force':revision.evaluate('d=>d.close()')
                        else:
                            page.locator('#import-revision-override-accept').check();self.assertTrue(accept.is_enabled());accept.click()
                        revision.wait_for(state='hidden')
                        # Closing a native dialog queues its close event. Wait for this
                        # specific promise, not a result from an earlier iteration,
                        # before reusing the same dialog (as revisionBusy does in main).
                        page.wait_for_function('n=>window.ordinaryDialogs.results.length===n',arg=step)
                        self.assertEqual(page.evaluate('window.ordinaryDialogs.results'),
                                         [False]*min(step,3)+([True] if step==4 else []))
                    page.wait_for_function('window.ordinaryDialogs.results.length===4')
                    self.assertEqual(page.evaluate('window.ordinaryDialogs.results'),[False,False,False,True])
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_shared_confirmation_safe_dismissal_and_focus(self):
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(320,480,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const mod=await import('finance-fixture/ui/modal.js');
                      const parent=document.createElement('dialog'),opener=document.createElement('button');
                      opener.textContent='テスト開始';parent.append(opener);document.body.append(parent);parent.showModal();
                      const owner={},results=[];window.confirmTest={owner,results,parent,opener};
                      window.confirmTest.open=()=>{opener.focus();void mod.requestConfirmation({owner,parent,title:'削除しますか？',message:'<img src=x onerror=alert(1)>\\n内容を確認',acceptLabel:'削除する',destructive:true}).then(x=>results.push(x));};
                      window.confirmTest.duplicate=()=>mod.requestConfirmation({owner,title:'別の確認',message:'二重操作',acceptLabel:'実行'});
                      window.confirmTest.cancel=()=>mod.cancelConfirmation(owner);
                    }''')
                    for theme in ('light','dark'):
                        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                        page.evaluate('window.confirmTest.open()');dialog=page.locator('.finance-confirm-dialog')
                        self.assertTrue(dialog.evaluate("d=>d.classList.contains('finance-modal')&&getComputedStyle(d).borderRadius==='14px'"))
                        self.assertEqual(dialog.locator('img').count(),0)
                        self.assertIn('<img src=x',dialog.inner_text())
                        self.assertTrue(dialog.get_by_role('button',name='キャンセル').evaluate('x=>document.activeElement===x'))
                        self.assertFalse(page.evaluate('window.confirmTest.duplicate()'))
                        self.assertEqual(dialog.count(),1)
                        self.assertTrue(dialog.evaluate('(d)=>{const r=d.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}'))
                        page.mouse.click(1,1);dialog.wait_for(state='detached')
                        self.assertFalse(page.evaluate('window.confirmTest.results.at(-1)'))
                        self.assertTrue(page.evaluate('document.activeElement===window.confirmTest.opener'))
                    page.evaluate('window.confirmTest.open()')
                    box=dialog.bounding_box();page.mouse.move(box['x']+20,box['y']+20);page.mouse.down();page.mouse.move(1,1);page.mouse.up()
                    self.assertTrue(dialog.is_visible())
                    dialog.get_by_role('button',name='閉じる').click();dialog.wait_for(state='detached')
                    self.assertFalse(page.evaluate('window.confirmTest.results.at(-1)'))
                    page.evaluate('window.confirmTest.open()');page.keyboard.press('Escape');dialog.wait_for(state='detached')
                    self.assertFalse(page.evaluate('window.confirmTest.results.at(-1)'))
                    page.evaluate('window.confirmTest.open()');page.evaluate('window.confirmTest.cancel()');dialog.wait_for(state='detached')
                    self.assertFalse(page.evaluate('window.confirmTest.results.at(-1)'))
                    page.evaluate('window.confirmTest.open()');dialog.get_by_role('button',name='削除する').click();dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('window.confirmTest.results.filter(Boolean).length'),1)
                    page.evaluate('window.confirmTest.open()');page.evaluate('window.confirmTest.parent.close()');dialog.wait_for(state='detached')
                    self.assertFalse(page.evaluate('window.confirmTest.results.at(-1)'))
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_security_confirmation_typed_cleanup_and_rotation(self):
        html=self.offline_document()
        for width,height,mobile in ((1100,750,False),(320,480,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      // Opaque about:blank has no storage or relative URL base. Supply only
                      // a synthetic environment, never an actual Microsoft account or token.
                      const stored=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},configurable:true});
                      const NativeURL=window.URL;
                      window.URL=class extends NativeURL {constructor(input,base){super(input,base==='about:blank'?'https://finance-e2e.invalid/':base);}};
                      const settings=await import('finance-fixture/cloud/cloud-settings.js');
                      const modal=await import('finance-fixture/ui/modal.js');
                      const test=window.securityTest={epoch:0,deletes:[],rotations:0,recoveries:0,cancel:()=>modal.cancelAllConfirmations()};
                      try{settings.initCloudSettings({hasUnsavedChanges:()=>false,confirmationContext:()=>{const epoch=test.epoch;return ()=>epoch===test.epoch;},
                        onRefresh:async()=>{},onMigration:async()=>{},onLock:async()=>true,
                        onRecoverSaveLock:async approve=>{if(!await approve('2026-01-01T00:00:00Z'))return 'cancelled';test.recoveries++;return 'released';},
                        onCleanupPreview:async()=>({generationCount:2,legacyFolderCount:0,unreferencedOriginalCount:1,legacyV1Count:0,snapshots:[]}),
                        onCleanupDelete:async which=>{test.deletes.push(which);return 2;},onChangePassphrase:async()=>{test.rotations++;}});}finally{window.URL=NativeURL;}
                      for(const view of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"]'))view.classList.toggle('hidden',view.id!=='settings-view');
                      for(const el of document.querySelectorAll('#settings-view details'))el.open=true;
                    }''')
                    dialog=page.locator('.finance-confirm-dialog')
                    def open_recovery():
                        # Synthetic disconnected document: allow the test-only
                        # click, without authenticating to a real account.
                        page.evaluate("document.getElementById('cloud-lock-recover').disabled=false")
                        page.locator('#cloud-lock-recover').click();dialog.wait_for()
                        self.assertIn('他のすべてのFinanceタブを閉じ',dialog.inner_text())
                    open_recovery()
                    recover_text=dialog.get_by_role('textbox',name='確認用の文字列')
                    recover_accept=dialog.get_by_role('button',name='復旧する')
                    self.assertTrue(recover_accept.is_disabled());recover_text.fill('解除 ');self.assertTrue(recover_accept.is_disabled())
                    recover_text.fill('解除');page.keyboard.press('Escape');dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('securityTest.recoveries'),0)
                    open_recovery();recover_text.fill('解除');recover_accept.click();dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('securityTest.recoveries'),1)
                    self.assertIn('保存ロックを解除しました',page.locator('#cloud-lock-check-result').inner_text())
                    def scan():
                        page.locator('#cloud-cleanup-scan').click()
                        page.locator('#cloud-cleanup-options').wait_for(state='visible')
                        page.locator('#cloud-cleanup-versions').check();page.locator('#cloud-cleanup-backup').check()
                    def open_delete():
                        page.locator('#cloud-cleanup-delete').click();dialog.wait_for()
                        self.assertIn('旧版のタブを閉じ',dialog.inner_text())
                    scan();open_delete()
                    typed=dialog.get_by_role('textbox',name='確認用の文字列');accept=dialog.get_by_role('button',name='削除する')
                    self.assertTrue(accept.is_disabled());typed.fill('削除 ');self.assertTrue(accept.is_disabled())
                    typed.fill('削除');self.assertTrue(accept.is_enabled())
                    page.keyboard.press('Escape');dialog.wait_for(state='detached');self.assertEqual(page.evaluate('securityTest.deletes.length'),0)
                    open_delete();typed.fill('削除');page.evaluate("document.getElementById('cloud-cleanup-originals').checked=true")
                    accept.click();dialog.wait_for(state='detached');self.assertEqual(page.evaluate('securityTest.deletes.length'),0)
                    page.locator('#cloud-cleanup-originals').uncheck();open_delete();typed.fill('削除')
                    page.evaluate('securityTest.epoch++;securityTest.cancel()');dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('securityTest.deletes.length'),0)
                    page.locator('#cloud-cleanup-delete').click();self.assertEqual(dialog.count(),0)
                    scan();open_delete();typed.fill('削除');accept.click();dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('securityTest.deletes'),[{'oldGenerations':True,'unreferencedOriginals':False,'unversionedFolders':False,'legacyV1':False,'snapshotIds':[]}])
                    def rotate():
                        page.locator('#cloud-current-secret').fill('synthetic-old-password')
                        page.locator('#cloud-next-secret').fill('synthetic-new-password')
                        page.locator('#cloud-next-confirm').fill('synthetic-new-password')
                        page.locator('#cloud-rotate-submit').click();dialog.wait_for()
                        self.assertNotIn('synthetic-',dialog.inner_text())
                        self.assertIn('旧版のタブを閉じ',dialog.inner_text())
                    rotate();page.evaluate("document.getElementById('cloud-next-secret').value='different-synthetic'")
                    dialog.get_by_role('button',name='再暗号化する').click();dialog.wait_for(state='detached');self.assertEqual(page.evaluate('securityTest.rotations'),0)
                    rotate();page.evaluate('securityTest.epoch++;securityTest.cancel()');dialog.wait_for(state='detached');self.assertEqual(page.evaluate('securityTest.rotations'),0)
                    rotate();dialog.get_by_role('button',name='再暗号化する').click();dialog.wait_for(state='detached')
                    self.assertEqual(page.evaluate('securityTest.rotations'),1)
                    self.assertEqual(page.locator('#cloud-next-secret').input_value(),'');self.assertEqual(errors,[])
                finally:context.close()

    def test_grouped_navigation_reachable_in_short_viewports(self):
        import re
        html=(ROOT/'dist/index.html').read_text(encoding='utf-8')
        css=(ROOT/'dist/styles/app.css').read_text(encoding='utf-8')
        aside=re.search(r'<aside id="finance-sidebar".*?</aside>',html,re.S).group(0)
        for width,height,mobile in ((1280,600,False),(390,640,True),(320,480,True)):
            with self.subTest(width=width,height=height):
                context=self.browser.new_context(viewport={'width':width,'height':height},is_mobile=mobile,has_touch=mobile,reduced_motion='reduce')
                try:
                    page=context.new_page()
                    page.set_content('<meta name="viewport" content="width=device-width, initial-scale=1"><style>'+css+'</style><div class="app-shell">'+aside+'<main class="workspace"></main></div>')
                    if mobile: page.locator('#finance-sidebar').evaluate("e=>e.classList.add('mobile-open')")
                    labels=page.locator('.nav-section-label')
                    self.assertEqual(labels.all_text_contents(),['ダッシュボード','データ管理','記録・将来設計','環境設定'])
                    for label in labels.all(): self.assertTrue(label.is_visible())
                    self.assertTrue(page.locator('#nav-home').is_visible())
                    self.assertEqual(page.locator('#nav-payroll').count(),0)
                    for theme in ('light','dark'):
                        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                        for icon in page.locator('#mobile-nav-panel button.nav-entry[id^="nav-"] .nav-symbol svg').all():
                            icon.scroll_into_view_if_needed()
                            result=icon.evaluate("""e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);const b=e.getBBox();return {w:r.width,h:r.height,stroke:s.stroke,color:s.color,fill:s.fill,bounds:[b.x,b.y,b.x+b.width,b.y+b.height]}}""")
                            self.assertAlmostEqual(result['w'],20,delta=1)
                            self.assertAlmostEqual(result['h'],20,delta=1)
                            self.assertEqual(result['stroke'],result['color'])
                            self.assertEqual(result['fill'],'none')
                            self.assertTrue(all(0<=v<=24 for v in result['bounds']),result)
                    page.locator('#nav-settings').scroll_into_view_if_needed()
                    self.assertTrue(page.locator('#nav-settings').evaluate('e=>{const r=e.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0}'))
                    self.assertTrue(page.locator('#nav-settings').is_visible())
                    if not mobile:
                        page.locator('#nav-home').scroll_into_view_if_needed()
                        y=page.locator('#nav-home .nav-symbol').bounding_box()['y']
                        page.locator('.app-shell').evaluate("e=>e.classList.add('nav-collapsed')")
                        page.locator('#nav-home').scroll_into_view_if_needed()
                        self.assertAlmostEqual(page.locator('#nav-home .nav-symbol').bounding_box()['y'],y,delta=1)
                        page.locator('.app-shell').evaluate("e=>e.classList.add('nav-peeking')")
                        self.assertAlmostEqual(page.locator('#nav-home .nav-symbol').bounding_box()['y'],y,delta=1)
                finally:
                    context.close()

    def test_connection_actions_follow_panel_width(self):
        # Actual shipped markup and CSS, without initializing auth or a vault.
        import re
        html = (ROOT / 'dist/index.html').read_text(encoding='utf-8')
        css = (ROOT / 'dist/styles/app.css').read_text(encoding='utf-8')
        actions = re.search(r'<div class="cloud-primary-actions"[^>]*>.*?</div>', html, re.S)
        self.assertIsNotNone(actions)
        for mobile, viewport, width, columns in (
            (False, 1100, 700, 4), (False, 1100, 520, 4),
            (False, 1100, 519, 2), (False, 1100, 468, 2),
            (True, 390, 300, 2), (True, 320, 240, 2),
            (True, 320, 239, 1), (True, 320, 200, 1),
        ):
            with self.subTest(mobile=mobile, width=width):
                context = self.browser.new_context(viewport={'width':viewport,'height':850},
                    is_mobile=mobile, has_touch=mobile)
                try:
                    page = context.new_page()
                    page.set_content('<meta name="viewport" content="width=device-width, initial-scale=1">'
                        + '<style>' + css + '</style><main class="settings-view">'
                        + '<section class="panel cloud-overview" style="box-sizing:content-box;'
                        + f'width:{width}px;max-width:none;padding:0;border:0;margin:0">'
                        + actions.group(0) + '</section></main>')
                    for connected in (False, True):
                        page.locator('#cloud-login').evaluate("(e, text)=>e.textContent=text",
                            '通信再試行' if connected else 'Microsoft接続')
                        for theme in ('light','dark'):
                            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                            result = page.locator('.cloud-primary-actions').evaluate('''(grid)=>{
                              const children=[...grid.children].filter(e=>getComputedStyle(e).display!=='none');
                              return {columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
                                buttons:children.map(e=>{const r=e.getBoundingClientRect();
                                  const range=document.createRange();range.selectNodeContents(e);
                                  return {x:r.x,y:r.y,w:r.width,h:r.height,
                                    lines:range.getClientRects().length,
                                    fits:e.scrollWidth<=e.clientWidth};})};
                            }''')
                            self.assertEqual(result['columns'], columns, result)
                            buttons=result['buttons']
                            self.assertEqual(len(buttons),4,result)
                            for i,button in enumerate(buttons):
                                self.assertAlmostEqual(button['w'],buttons[0]['w'],delta=1)
                                self.assertAlmostEqual(button['h'],buttons[0]['h'],delta=1)
                                self.assertGreaterEqual(button['h'],44)
                                self.assertEqual(button['lines'],1,result)
                                self.assertTrue(button['fits'],result)
                                self.assertAlmostEqual(button['x'],buttons[i%columns]['x'],delta=1)
                                self.assertAlmostEqual(button['y'],buttons[(i//columns)*columns]['y'],delta=1)
                    for selector in ('#cloud-resume-batch','#cloud-new-vault'):
                        optional=page.locator(selector)
                        self.assertFalse(optional.is_visible())
                        optional.evaluate("e=>e.classList.remove('hidden')")
                        self.assertTrue(optional.is_visible())
                        self.assertGreater(optional.bounding_box()['y'],page.locator('#cloud-live-lock').bounding_box()['y'])
                        self.assertTrue(optional.evaluate('e=>e.scrollWidth<=e.clientWidth'))
                        optional.evaluate("e=>e.classList.add('hidden')")
                finally:
                    context.close()

    def test_release_history_without_cloud_and_failed_fetch(self):
        import json
        from playwright.sync_api import expect
        entries=json.loads((ROOT/'dist/release-notes.json').read_text(encoding='utf-8'))
        html=self.offline_document()
        for width in (1100,390,320):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':750},is_mobile=width<800,has_touch=width<800)
                try:
                    page=context.new_page();page.set_default_timeout(5000);errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async(entries)=>{
                      window.releaseRequests=0;
                      window.fetch=async(url,options)=>{
                        if(url!=='./release-notes.json'||options.credentials!=='omit')throw new Error('unexpected request');
                        window.releaseRequests++;
                        if(window.releaseRequests===1)throw new Error('offline');
                        return new Response(JSON.stringify(entries),{headers:{'Content-Type':'application/json'}});
                      };
                      const {initReleaseHistory}=await import('finance-fixture/ui/release-history.js');
                      const {syncFinanceCloudGates}=await import('finance-fixture/ui/cloud-gate.js');
                      const state={blocked:true,locked:false,checking:false,notice:{kind:'not-connected',message:'未接続'},onRetry(){},onReauthenticate(){},onUnlock(){},onSettings(){}};
                      window.setReleaseLocked=()=>syncFinanceCloudGates({...state,locked:true});
                      syncFinanceCloudGates(state);initReleaseHistory();
                      document.documentElement.classList.remove('finance-nav-boot-collapsed');
                      document.getElementById('finance-sidebar').classList.add('mobile-open');
                      document.getElementById('mobile-nav-panel').inert=false;
                    }''',entries)
                    opener=page.locator('#release-history-open');dialog=page.locator('#release-history-dialog')
                    self.assertEqual(page.evaluate('window.releaseRequests'),0)
                    expect(dialog).not_to_be_visible()
                    opener.click();expect(dialog).to_contain_text('アップデート履歴を取得できませんでした')
                    dialog.get_by_role('button',name='閉じる').click();expect(dialog).not_to_be_visible()
                    page.evaluate('window.setReleaseLocked()')
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        opener.click();expect(dialog).to_be_visible()
                        expect(dialog.locator('article')).to_have_count(len(entries))
                        self.assertTrue(dialog.evaluate("d=>d.classList.contains('finance-modal')&&getComputedStyle(d).borderRadius==='14px'"))
                        expect(dialog.locator('article').first).to_contain_text('v'+entries[0]['version'])
                        expect(dialog.locator('.release-history-latest')).to_have_count(1)
                        expect(dialog.locator('article').last).to_contain_text('初期開発')
                        self.assertTrue(dialog.evaluate('(d)=>d.scrollHeight>d.clientHeight&&d.scrollWidth<=d.clientWidth+1'))
                        self.assertTrue(dialog.evaluate('(d)=>{const r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}'))
                        page.keyboard.press('Escape');expect(dialog).not_to_be_visible();expect(opener).to_be_focused()
                    self.assertEqual(page.evaluate('window.releaseRequests'),2)
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_closed_future_comparison_ignores_invalid_start_month(self):
        from playwright.sync_api import expect
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initFutureProjection}=await import('finance-fixture/ui/future-projection.js');
                      const d=new Date(),today=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
                      const assets=emptyAssets();assets.birthMonth=`${d.getFullYear()-25}-01`;
                      assets.snapshots=[{id:'cash-test',accountId:'cash-savings',balance:100000,observedAt:`${today}T00:00:00Z`},{id:'nisa-test',accountId:'nisa',balance:200000,observedAt:`${today}T00:00:00Z`}];
                      document.getElementById('future-view').classList.remove('hidden');
                      initFutureProjection(()=>({assets,records:[]})).render();
                    }''')
                    scenario=page.locator('#future-scenario-accordion');summary=scenario.locator('summary')
                    start=page.locator('#future-change-month');hint=page.locator('#future-hint');graph=page.locator('.future-chart-svg')
                    baseline=page.locator('.future-table').text_content()
                    valid=start.input_value()
                    expect(graph).to_be_visible()
                    for invalid in ('','2000-01'):
                        summary.click();expect(page.locator('.future-metric-scenario')).to_be_visible()
                        start.fill(invalid);expect(hint).to_have_text('年月と積立額を確認してください。');expect(graph).to_have_count(0)
                        summary.click();expect(graph).to_be_visible();expect(hint).to_have_text('')
                        expect(page.locator('.future-table')).to_have_text(baseline)
                        expect(start).to_have_value(invalid);expect(page.locator('.future-metric-scenario')).to_have_count(0)
                        summary.click();expect(hint).to_have_text('年月と積立額を確認してください。');expect(start).to_have_value(invalid)
                        start.fill(valid);expect(graph).to_be_visible();expect(page.locator('.future-metric-scenario')).to_be_visible()
                        summary.click();expect(page.locator('.future-metric-scenario')).to_have_count(0)
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_analysis_partial_totals_match_annual_comparison(self):
        from datetime import datetime, timezone
        from playwright.sync_api import expect
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile,timezone_id='Asia/Tokyo')
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.clock.set_fixed_time(datetime(2026,3,25,3,tzinfo=timezone.utc))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initAnalysis}=await import('finance-fixture/ui/analysis.js');
                      const pay=(p,amount=200000)=>({id:'pay-'+p,employerId:'main',job:'main',paidOn:p+'-10',payPeriod:p,netPay:amount,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1});
                      const bill=(p,amount,confirmation='confirmed')=>({id:'bill-'+p,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:p+'-20',statedTotal:amount,confirmation,warnings:[],rows:[{id:'row-'+p,usedOn:p+'-01',merchant:'SYNTHETIC SHOP',amount}]}});
                      const periods=['2025-01','2025-02','2025-03','2026-01','2026-02','2026-03'];
                      const source={records:[...periods.slice(0,3).map(p=>bill(p,200000)),bill('2026-01',150000),bill('2026-02',180000)],rules:[],categories:[],assets:emptyAssets(),payroll:{ready:true,syncedAt:1000,entries:periods.map(p=>pay(p))},currentPeriod:'2026-03'};
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))node.classList.toggle('hidden',node.id!=='analysis-view');
                      const opened=[];const ui=initAnalysis({source:()=>source,openMonth(p){opened.push(p)},openDrilldown(){},openSettings(){}});ui.render();
                      window.coverageAnalysis={opened,complete(){source.records.push(bill('2026-03',70000,'provisional'));ui.render();},missingIncome(){source.payroll.entries=source.payroll.entries.filter(p=>p.payPeriod!=='2026-01');ui.render();},empty(){source.records=[];source.payroll={ready:false,syncedAt:null,entries:[]};ui.render();}};
                    }''')
                    root=page.locator('#analysis-content')
                    root.get_by_role('button',name='3か月',exact=True).click()
                    metrics=root.locator('.analysis-metrics .analysis-metric')
                    expect(metrics.nth(0).locator('strong')).to_have_text('600,000円')
                    expect(metrics.nth(0)).to_contain_text('3/3か月')
                    expect(metrics.nth(1).locator('strong')).to_have_text('算出不可')
                    expect(metrics.nth(1)).to_contain_text('判明分 330,000円')
                    expect(metrics.nth(2).locator('strong')).to_have_text('算出不可')
                    expect(metrics.nth(2)).to_contain_text('判明分 +70,000円')
                    expect(root.locator('.analysis-cumulative-total')).to_have_text('算出不可')
                    expect(root.locator('.analysis-cumulative-point')).to_have_count(2)
                    expect(metrics.nth(2)).to_contain_text('NISAを除く：算出不可')
                    expect(metrics.nth(2)).to_contain_text('2/3か月')
                    root.get_by_role('button',name='年間',exact=True).click()
                    comparison=root.locator('.analysis-panel').filter(has=page.get_by_role('heading',name='前年との比較',exact=True))
                    current=comparison.locator('tbody tr').nth(0).locator('td')
                    previous=comparison.locator('tbody tr').nth(1).locator('td')
                    for cell,amount,detail in ((current.nth(1),'600,000円','3/3か月'),(current.nth(2),'算出不可','判明分 330,000円'),(current.nth(3),'算出不可','判明分 +70,000円'),(previous.nth(2),'600,000円','3/3か月'),(previous.nth(3),'0円','3/3か月')):
                        expect(cell.locator('div').first).to_have_text(amount)
                        expect(cell).to_contain_text(detail)
                    expect(current.nth(3)).to_contain_text('2/3か月')
                    expect(comparison).to_contain_text('比較できる明細が揃っていません')
                    page.evaluate('coverageAnalysis.complete()')
                    expect(metrics.nth(2).locator('strong')).to_have_text('200,000円')
                    expect(metrics.nth(2)).to_contain_text('3/3か月')
                    expect(metrics.nth(2)).to_contain_text('参考値')
                    expect(root.locator('.analysis-cumulative-total')).to_have_text('200,000円')
                    expect(root.locator('.analysis-cumulative-point')).to_have_count(3)
                    expect(root.locator('.analysis-cumulative-line.reference')).to_have_count(1)
                    review=root.get_by_role('button',name='2026年3月 暫定の詳細を確認')
                    expect(review).to_be_visible();review.click();self.assertEqual(page.evaluate('coverageAnalysis.opened'),['2026-03'])
                    expect(review.locator('..')).to_contain_text('暫定明細 1件')
                    expect(metrics.nth(2)).to_contain_text('NISAを除く：200,000円')
                    expect(current.nth(2).locator('div').first).to_have_text('400,000円')
                    page.evaluate('coverageAnalysis.missingIncome()')
                    expect(metrics.nth(2).locator('strong')).to_have_text('算出不可')
                    expect(metrics.nth(2)).to_contain_text('2/3か月')
                    expect(metrics.nth(1).locator('strong')).to_have_text('400,000円')
                    page.evaluate('coverageAnalysis.empty()')
                    expect(metrics.nth(2).locator('strong')).to_have_text('算出不可')
                    expect(metrics.nth(2)).to_contain_text('0/3か月')
                    expect(metrics.nth(2)).not_to_contain_text('判明分')
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_future_nisa_schedule_and_card_rule_lifecycle(self):
        from datetime import datetime, timezone
        from playwright.sync_api import expect
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile,timezone_id='Asia/Tokyo')
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.clock.set_fixed_time(datetime(2026,11,17,3,tzinfo=timezone.utc))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,withUpdatedNisaCardRule}=await import('finance-fixture/cloud/assets.js');
                      const {initFutureProjection}=await import('finance-fixture/ui/future-projection.js');
                      let assets=emptyAssets();assets.birthMonth='2001-01';
                      assets.snapshots=[{id:'cash-test',accountId:'cash-savings',balance:100000,observedAt:'2026-11-01T12:00:00+09:00'},{id:'nisa-test',accountId:'nisa',balance:200000,observedAt:'2026-11-01T12:00:00+09:00'}];
                      assets.nisaCardRule={cardId:'rakuten-mizuho',merchantContains:'Synthetic investment',enabled:true};
                      assets.recurring=[{id:'cash-test-rule',name:'Synthetic savings',kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'cash-savings',amount:24000,frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:null,categoryId:null,enabled:true,pricing:[{effectiveOn:'2026-01-01',amount:12000},{effectiveOn:'2026-12-01',amount:24000}]},
                        {id:'nisa-test-rule',name:'Synthetic NISA',kind:'transfer',fromAccountId:'rakuten-bank',toAccountId:'nisa',amount:15000,frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:'2026-01-01',endOn:'2026-10-31',categoryId:null,enabled:true}];
                      assets.recurring.push({...assets.recurring[0],id:'cash-ended',name:'Synthetic ended savings',amount:20000,pricing:undefined,endOn:'2026-10-31'});
                      const records=[{id:'sample-record',statement:{cardId:'rakuten-mizuho',rows:[{id:'sample-row',usedOn:'2026-11-10',merchant:'Synthetic investment',amount:20000}]}}];
                      document.getElementById('future-view').classList.remove('hidden');
                      const ui=initFutureProjection(()=>({assets,records}));ui.render();
                      window.nisaLifecycle={remove(){assets=withUpdatedNisaCardRule(assets,null,'2026-11-17');ui.render();},
                        schedule(){assets={...assets,recurring:assets.recurring.map(e=>e.toAccountId==='nisa'?{...e,startOn:'2027-01-01',endOn:null}:e)};ui.render();}};
                      const age=document.getElementById('future-age');age.value='26';age.dispatchEvent(new Event('input'));
                      const rate=document.getElementById('future-nisa-rate');rate.value='0';rate.dispatchEvent(new Event('input'));
                    }''')
                    hint=page.locator('#future-scenario-hint')
                    target_nisa=page.locator('.future-table tbody tr').last.locator('td').nth(2)
                    expect(page.locator('.future-chart-svg')).to_be_visible()
                    expect(hint).to_have_text('現在の月額目安：現金 12,000円 · NISA 20,000円')
                    expect(page.locator('#future-saving-amount')).to_have_value('20000')
                    expect(page.locator('#future-scenario-nisa')).to_have_value('25000')
                    expect(target_nisa).to_have_text('260,000円')
                    expect(page.locator('.future-warning')).to_have_count(0)
                    page.evaluate('nisaLifecycle.schedule()')
                    expect(target_nisa).to_have_text('255,000円')
                    expect(hint).to_have_text('現在の月額目安：現金 12,000円 · NISA 20,000円')
                    expect(page.locator('.future-warning')).to_contain_text('重複')
                    page.evaluate('nisaLifecycle.remove()')
                    expect(hint).to_have_text('現在の月額目安：現金 12,000円 · NISA 0円')
                    expect(target_nisa).to_have_text('235,000円')
                    expect(page.locator('.future-table tbody tr').first.locator('td').nth(2)).to_have_text('220,000円')
                    expect(page.locator('.future-warning')).to_have_count(0)
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_graph_pointer_drag_keyboard_zoom_desktop(self):
        page, context, errors = self.create_page()
        try:
            self.prepare_graph(page)
            svg = page.locator('.future-chart-svg')
            svg.scroll_into_view_if_needed()
            max_index = int(svg.get_attribute('aria-valuemax'))
            self.assertGreater(max_index, 50)
            for x, expected in [(50, 0), (437, round(max_index / 2)), (824, max_index)]:
                pt = self.point(page, x)
                page.mouse.click(pt['x'], pt['y'])
                self.assertAlmostEqual(int(svg.get_attribute('aria-valuenow')), expected, delta=1)
            svg.focus()
            page.keyboard.press('Home')
            self.assertEqual(int(svg.get_attribute('aria-valuenow')), 0)
            page.keyboard.press('ArrowRight')
            self.assertEqual(int(svg.get_attribute('aria-valuenow')), 1)
            page.keyboard.press('End')
            self.assertEqual(int(svg.get_attribute('aria-valuenow')), max_index)
            cash = page.locator('.future-chart-filter[data-series="cash"]')
            cash.focus()
            page.keyboard.press('Enter')
            self.assertEqual(page.evaluate('document.activeElement?.dataset.series'), 'cash')
            self.assertEqual(cash.get_attribute('aria-pressed'), 'true')
            start = self.point(page, 50)
            end = self.point(page, 824)
            page.mouse.move(start['x'],start['y'])
            page.mouse.down()
            page.mouse.move(end['x'],end['y'],steps=12)
            page.mouse.up()
            self.assertEqual(int(svg.get_attribute('aria-valuenow')), max_index)
            page.evaluate("document.body.style.zoom='1.35'")
            svg.scroll_into_view_if_needed()
            mid = self.point(page, 437)
            page.mouse.click(mid['x'],mid['y'])
            self.assertAlmostEqual(int(svg.get_attribute('aria-valuenow')), round(max_index/2),delta=1)
            self.assertFalse(errors,errors)
        finally:
            context.close()

    def test_graph_mobile_touch_and_vertical_page_scroll(self):
        page,context,errors = self.create_page(mobile=True,width=390)
        try:
            self.prepare_graph(page)
            svg = page.locator('.future-chart-svg')
            svg.scroll_into_view_if_needed()
            max_index=int(svg.get_attribute('aria-valuemax'))
            for x,idx in [(50,0),(824,max_index)]:
                pt=self.point(page,x)
                page.touchscreen.tap(pt['x'],pt['y'])
                self.assertAlmostEqual(int(svg.get_attribute('aria-valuenow')),idx,delta=1)
            tap_color=svg.evaluate('e=>getComputedStyle(e).webkitTapHighlightColor')
            self.assertIn(tap_color, ['rgba(0, 0, 0, 0)', 'transparent'])
            self.assertEqual(svg.evaluate('e=>getComputedStyle(e).touchAction'), 'pan-y')
            # A real CDP touch gesture must scroll the document, not lock it.
            page.evaluate('window.scrollTo(0,0)')
            svg.scroll_into_view_if_needed()
            before=page.evaluate('window.scrollY')
            box=svg.bounding_box()
            x=box['x']+box['width']*0.5
            y=box['y']+box['height']*0.5
            client=context.new_cdp_session(page)
            client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for n in range(1,8):
                client.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y-22*n}]})
                page.wait_for_timeout(32)
            client.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            page.wait_for_timeout(160)
            self.assertGreater(page.evaluate('window.scrollY'),before)
            self.assertFalse(errors,errors)
        finally:
            context.close()

    def test_rakuten_explicit_zero_statement(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':800},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate("""async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initMonthlySummary}=await import('finance-fixture/ui/monthly-summary.js');
                      const period='2024-04';
                      const source={records:[{id:'empty-card',originalId:'synthetic',statement:{provider:'rakuten',cardId:'rakuten-etc',sourceKind:'pdf',sourceName:'synthetic',billingMonth:period,paymentDate:null,statedTotal:0,confirmation:'confirmed',zeroUsage:true,warnings:[],rows:[]}}],rules:[],categories:[],assets:emptyAssets(),payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:period};
                      window.openedZero=null;
                      const summary=initMonthlySummary({source:()=>source,openRecord(id){window.openedZero=id;},openDrilldown(){},openCardSettings(){}});
                      for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!=='summary-view');
                      document.getElementById('summary-view').classList.remove('hidden');summary.setPeriod(period);
                    }""")
                    summary=page.locator('#monthly-content')
                    expense=summary.locator('.monthly-metric').filter(has=page.get_by_text('支出',exact=True))
                    self.assertEqual(expense.locator('.monthly-metric-value').inner_text(),'算出不可')
                    self.assertIn('一部カード未取得',expense.inner_text())
                    self.assertIn('支出総額は算出できません',summary.inner_text())
                    cards=summary.locator('.monthly-panel').filter(has=page.get_by_role('heading',name='カード別引落額',exact=True))
                    zero=cards.locator('.monthly-line').filter(has=page.get_by_role('button',name='利用なし確認済み',exact=False))
                    self.assertEqual(zero.count(),1)
                    self.assertEqual(zero.locator('strong').inner_text(),'0円')
                    zero.get_by_role('button').click()
                    self.assertEqual(page.evaluate('window.openedZero'),'empty-card')
                    self.assertEqual(errors,[])
                finally:
                    context.close()

    def test_quiet_metrics_and_review_record_navigation(self):
        from datetime import datetime, timezone
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile,timezone_id='Asia/Tokyo')
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.clock.set_fixed_time(datetime(2026,11,26,3,tzinfo=timezone.utc))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate("""async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initMonthlySummary}=await import('finance-fixture/ui/monthly-summary.js');
                      const {initAnalysis}=await import('finance-fixture/ui/analysis.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {initMonthlyReports}=await import('finance-fixture/ui/monthly-reports.js');
                      const bill=(id,p,confirmation,date=p+'-27')=>({id,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:date,statedTotal:128170,confirmation,warnings:[],rows:[{id:'row-'+id,usedOn:p+'-02',merchant:'TEST SHOP',amount:128170}]}});
                      const assets=emptyAssets();assets.cardDebitAccounts={'rakuten-mizuho':'mizuho-bank'};assets.mizuhoTransferPlan={enabled:true,leadDays:3,extraForSmallBills:false};
                      assets.oneTime=[{id:'paid-expense',name:'支出テスト',kind:'expense',amount:53605,date:'2026-10-10',fromAccountId:'rakuten-bank',toAccountId:null,status:'done',categoryId:null}];
                      const source={records:[bill('unknown-bill','2026-10','unknown'),bill('current-bill','2026-11','confirmed')],assets,rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null},currentPeriod:'2026-11'};
                      const show=id=>{for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!==id);document.getElementById(id).classList.remove('hidden');};
                      const opened=[];
                      const summary=initMonthlySummary({source:()=>source,openRecord:id=>opened.push(id),openDrilldown(){}});
                      const analysis=initAnalysis({source:()=>source,openMonth:p=>{show('summary-view');summary.setPeriod(p)},openDrilldown(){},openSettings(){}});
                      const home=initHome({source:()=>source,navigate(){}});
                      const reports=initMonthlyReports({source:()=>source,vault:()=>({unlocked:true,listArchivedMonths:async()=>[],loadArchivedReport:async()=>null}),openMonth(){}});
                      window.reviewFixture={source,summary,analysis,home,reports,show,opened,undated(){source.records.push(bill('undated-bill','2026-09','confirmed',null));analysis.render()}};
                      show('analysis-view');analysis.render();
                    }""")
                    analysis=page.locator('#analysis-content')
                    bar=analysis.locator('.analysis-chart-month').filter(has_text='10月')
                    self.assertIn('確定状態不明 1件',bar.get_attribute('aria-label'))
                    self.assertIn('月を選択すると該当明細',analysis.locator('.analysis-coverage').inner_text())
                    bar.click()
                    summary=page.locator('#monthly-content');quality=summary.locator('.monthly-panel').filter(has=page.get_by_role('heading',name='データの確認',exact=True))
                    self.assertIn('確定状態が不明な明細（集計済み）',quality.inner_text())
                    quality.get_by_role('button',name='確定状態不明',exact=False).click()
                    self.assertEqual(page.evaluate('reviewFixture.opened'),['unknown-bill'])
                    self.assertFalse(summary.get_by_role('heading',name='楽天銀行の残高推移').count())
                    expense=summary.locator('.monthly-metric').nth(1)
                    self.assertIn('181,775円',expense.inner_text());self.assertIn('明細要確認',expense.inner_text())
                    self.assertNotIn('カード引落',expense.inner_text());self.assertNotIn('53,605円',expense.inner_text())
                    self.assertIn('定期・単発支出合計',summary.inner_text());self.assertIn('53,605円',summary.inner_text())
                    self.assertTrue(quality.evaluate("e=>!!(e.compareDocumentPosition(document.querySelector('.monthly-triptych'))&Node.DOCUMENT_POSITION_FOLLOWING)"))
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        self.assertEqual(summary.locator('.monthly-metric strong.data-status-muted').first.evaluate('e=>getComputedStyle(e).fontSize'),'13px')
                        self.assertGreater(float(expense.locator('strong').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)')),13)
                    page.evaluate("reviewFixture.show('analysis-view');reviewFixture.undated()")
                    self.assertIn('全期間共通',analysis.locator('.analysis-coverage').inner_text())
                    analysis.locator('.analysis-chart-month').filter(has_text='11月').click()
                    self.assertIn('全期間共通',quality.inner_text());self.assertIn('支払日不明の明細は対象月を特定できない',quality.inner_text())
                    self.assertTrue(summary.get_by_role('heading',name='楽天銀行の残高推移').is_visible())
                    page.evaluate("reviewFixture.show('home-view');reviewFixture.home.render()")
                    home=page.locator('#home-content')
                    self.assertEqual(home.locator('.home-metric strong.data-status-muted').first.evaluate('e=>getComputedStyle(e).fontSize'),'13px')
                    self.assertEqual(home.locator('.home-funding-state').first.evaluate('e=>getComputedStyle(e).fontSize'),'11px')
                    self.assertEqual(home.locator('.home-account-forecast').count(),0)
                    page.evaluate("reviewFixture.show('reports-view');reviewFixture.reports.openPeriod('2026-11');reviewFixture.reports.render()")
                    missing=page.locator('#reports-content .reports-metric strong.data-status-muted').first;missing.wait_for()
                    self.assertEqual(missing.evaluate('e=>getComputedStyle(e).fontSize'),'13px')
                    self.assertFalse(errors,errors)
                finally:context.close()

    def test_polish_dashboard_coverage_and_report_preview(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {initMonthlySummary}=await import('finance-fixture/ui/monthly-summary.js');
                      const {initAnalysis}=await import('finance-fixture/ui/analysis.js');
                      const {initMonthlyReports}=await import('finance-fixture/ui/monthly-reports.js');
                      const {reportSnapshot}=await import('finance-fixture/reports/monthly-report.js');
                      const now=new Date(),pad=n=>String(n).padStart(2,'0'),current=now.getFullYear()+'-'+pad(now.getMonth()+1),day=current+'-'+pad(now.getDate());
                      const previousDate=new Date(now.getFullYear(),now.getMonth()-1,1),previous=previousDate.getFullYear()+'-'+pad(previousDate.getMonth()+1);
                      const assets=emptyAssets();assets.snapshots=[{id:'balance-test',accountId:'rakuten-bank',balance:100000,observedAt:previous+'-01T00:00:00Z'}];
                      const source={records:[],rules:[],categories:[],assets,payroll:{ready:true,syncedAt:1000,entries:[{id:'salary-a',employerId:'main',job:'main',paidOn:day,payPeriod:current,netPay:50000,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1}]},currentPeriod:current};
                      let writes=0,archive=null,settings=0;
                      const vault={unlocked:true,listArchivedMonths:async()=>archive?[current]:[],loadArchivedReport:async period=>period===current?archive:null,
                        saveArchivedReport:async(snapshot,note)=>{writes++;archive={format:'finance-monthly-report-v1',period:current,current:{id:'saved',savedAt:new Date().toISOString(),note,snapshot,sourceHash:'a'.repeat(64)},history:[]};return archive;}};
                      const show=id=>{for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!==id);document.getElementById(id).classList.remove('hidden');};
                      const summary=initMonthlySummary({source:()=>source,openRecord(){},openDrilldown(){},openCardSettings(){settings++;}});
                      const home=initHome({source:()=>source,navigate(){},openCardSettings(){settings++;}});
                      const analysis=initAnalysis({source:()=>source,openMonth(){},openDrilldown(){},openSettings(){}});
                      const reports=initMonthlyReports({source:()=>source,vault:()=>vault,openMonth(){}});
                      const bill={id:'bill-a',statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',billingMonth:previous,paymentDate:day,statedTotal:13000,confirmation:'confirmed',warnings:[],rows:Array.from({length:13},(_,i)=>({id:'row-'+i,usedOn:previous+'-02',merchant:'SHOP '+i,amount:1000}))}};
                      window.polish2={source,assets,summary,home,analysis,reports,current,day,show,writes:()=>writes,settings:()=>settings,
                        noUse(){assets.cardNoUseMonths=[current];summary.render();},
                        registered(){assets.cardNoUseMonths=[];source.records=[bill];assets.oneTime=[{id:'transfer-a',name:'テスト振替',kind:'transfer',amount:2500,date:day,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',status:'done',categoryId:null}];summary.render();},
                        historical(){const snap=reportSnapshot(current,source);archive.history=[{id:'old',savedAt:'2026-01-01T00:00:00Z',note:'旧版のメモ',snapshot:snap,sourceHash:'b'.repeat(64)}];reports.render();}};
                      show('summary-view');summary.setPeriod(current);
                    }''')
                    summary=page.locator('#monthly-content')
                    self.assertEqual(summary.locator('.points-benefits-heading strong').inner_text(),'明細未取得')
                    self.assertEqual(summary.locator('.points-benefits-list').count(),0)
                    self.assertEqual(summary.locator('.points-benefits-compact').count(),1)
                    self.assertIn('明細未取得',summary.locator('.points-benefits').inner_text())
                    page.evaluate('window.polish2.noUse()')
                    self.assertEqual(summary.locator('.points-benefits-heading strong').inner_text(),'0 pt')
                    self.assertEqual(summary.locator('.monthly-alert').count(),0)
                    self.assertEqual(summary.get_by_role('heading',name='データの確認').count(),0)
                    self.assertIn('前月比',summary.locator('.monthly-metric').last.inner_text())
                    page.evaluate('window.polish2.registered()')
                    self.assertEqual(summary.locator('.points-benefits-heading strong').inner_text(),'65 pt')
                    self.assertIn('登録済み明細分',summary.locator('.points-benefits').inner_text())
                    summary.get_by_role('button',name='カード設定を開く').click()
                    self.assertEqual(page.evaluate('window.polish2.settings()'),1)
                    dates=summary.locator('.monthly-chart-date-controls');dates.locator('summary').click()
                    date_buttons=dates.locator('button');self.assertGreaterEqual(date_buttons.count(),2)
                    date_buttons.first.focus();page.keyboard.press('End')
                    self.assertEqual(date_buttons.last.get_attribute('aria-pressed'),'true')
                    page.evaluate("window.polish2.show('home-view');window.polish2.home.render()")
                    home=page.locator('#home-content')
                    self.assertIn('−13,000円',home.inner_text())
                    self.assertIn('実行済み',home.inner_text())
                    self.assertIn('楽天銀行 → みずほ銀行',home.inner_text())
                    self.assertEqual(home.locator('.home-debit').filter(has_text='テスト振替').count(),1)
                    self.assertEqual(home.locator('.home-debit').filter(has_text='テスト振替').locator('b').inner_text(),'2,500円')
                    self.assertEqual(home.locator('.home-metric > span').all_text_contents(),['収入','支出','収支'])
                    self.assertIn('前月比：比較不可',home.locator('.home-metric').last.inner_text())
                    page.evaluate('''()=>{const {source,current,home}=window.polish2;const previous=new Date(Number(current.slice(0,4)),Number(current.slice(5))-2,1).toLocaleDateString('sv-SE').slice(0,7);source.assets.cardNoUseMonths=[previous];source.payroll.entries.push({...source.payroll.entries[0],id:'salary-prev',paidOn:previous+'-01',payPeriod:previous,netPay:25000});home.render()}''')
                    self.assertIn('前月比：+12,000円',home.locator('.home-metric').last.inner_text())
                    self.assertEqual(summary.locator('.monthly-metric-label').all_text_contents(),['収入','支出','収支'])
                    page.evaluate('''()=>{const {assets,day,home}=window.polish2;assets.oneTime.push(...Array.from({length:7},(_,i)=>({id:'other-'+i,name:'別振替'+i,kind:'transfer',amount:2500,date:day,fromAccountId:'rakuten-bank',toAccountId:'mizuho-bank',status:'planned',categoryId:null})));home.render()}''')
                    self.assertEqual(home.locator('.home-debit').count(),6)
                    home.get_by_role('button',name='すべて表示',exact=True).click()
                    self.assertEqual(home.locator('.home-debit').filter(has_text='別振替').count(),7)
                    home.get_by_role('button',name='折りたたむ',exact=True).click()
                    self.assertEqual(home.locator('.home-debit').count(),6)
                    page.evaluate("window.polish2.assets.oneTime=window.polish2.assets.oneTime.filter(x=>x.id==='transfer-a');window.polish2.home.render()")
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        self.assertTrue(home.locator('.home-account').first.is_visible())
                        self.assertEqual(home.locator('.home-account-forecast').count(),0)
                        self.assertTrue(home.locator('.home-account').evaluate_all('xs=>xs.every(e=>e.scrollWidth<=e.clientWidth+1)'))
                    page.evaluate("window.polish2.show('analysis-view');window.polish2.analysis.render()")
                    analysis=page.locator('#analysis-content')
                    analysis.get_by_role('button',name='利用先',exact=True).click()
                    self.assertIn('上位12件 / 全13件',analysis.inner_text())
                    self.assertTrue(analysis.locator('.points-benefits').evaluate('(n)=>n===n.parentElement.lastElementChild'))
                    page.evaluate("window.polish2.show('reports-view');window.polish2.reports.openPeriod(window.polish2.current);window.polish2.reports.render()")
                    reports=page.locator('#reports-content')
                    reports.get_by_text('未保存プレビュー').wait_for()
                    self.assertEqual(page.evaluate('window.polish2.writes()'),0)
                    self.assertTrue(reports.locator('.reports-metrics').first.evaluate("(n)=>!!(n.compareDocumentPosition(document.querySelector('#reports-memo'))&Node.DOCUMENT_POSITION_FOLLOWING)"))
                    reports.locator('#reports-memo').fill('テストメモ')
                    reports.get_by_role('button',name='レポートを作成').click()
                    reports.get_by_text('保存済み',exact=False).first.wait_for()
                    page.wait_for_function('window.polish2.writes()===1 && !!document.querySelector("#reports-memo")')
                    self.assertEqual(reports.locator('#reports-memo').input_value(),'テストメモ')
                    self.assertFalse(page.evaluate('window.polish2.reports.isDirty()'))
                    reports.locator('#reports-memo').fill('編集中')
                    self.assertTrue(page.evaluate('window.polish2.reports.isDirty()'))
                    reports.locator('#reports-memo').fill('テストメモ')
                    self.assertFalse(page.evaluate('window.polish2.reports.isDirty()'))
                    page.evaluate("window.polish2.reports.openPeriod('2025-01');window.polish2.reports.render()")
                    reports.locator('#reports-memo').wait_for()
                    self.assertFalse(page.evaluate('window.polish2.reports.isDirty()'))
                    page.evaluate('window.polish2.reports.openPeriod(window.polish2.current);window.polish2.reports.render()')
                    reports.locator('#reports-memo').wait_for()
                    self.assertFalse(page.evaluate('window.polish2.reports.isDirty()'))
                    reports.locator('#reports-memo').fill('保持する下書き')
                    page.evaluate("window.polish2.reports.openPeriod('2025-01');window.polish2.reports.render()")
                    reports.locator('#reports-memo').wait_for()
                    self.assertTrue(page.evaluate('window.polish2.reports.isDirty()'))
                    page.evaluate('window.polish2.reports.openPeriod(window.polish2.current);window.polish2.reports.render()')
                    reports.locator('#reports-memo').wait_for()
                    self.assertEqual(reports.locator('#reports-memo').input_value(),'保持する下書き')
                    reports.locator('#reports-memo').fill('テストメモ')
                    self.assertFalse(page.evaluate('window.polish2.reports.isDirty()'))
                    page.evaluate('window.polish2.historical()')
                    reports.locator('.reports-history summary').click();reports.locator('.reports-history-button').click()
                    self.assertEqual(reports.locator('#reports-memo').count(),0)
                    self.assertIn('旧版のメモ',reports.inner_text())
                    reports.get_by_role('button',name='最新版へ戻る').click()
                    self.assertEqual(reports.locator('#reports-memo').input_value(),'テストメモ')
                    self.assertEqual(page.evaluate('window.polish2.writes()'),1)
                    self.assertFalse(errors,errors)
                finally:context.close()

    def test_polish_management_disclosures_and_current_values(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':760},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,cardRecurringKey}=await import('finance-fixture/cloud/assets.js');
                      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=> 'synthetic-candidate-contract-id'});
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const {initAssetsSettings}=await import('finance-fixture/ui/assets-settings.js');
                      const {initFutureProjection}=await import('finance-fixture/ui/future-projection.js');
                      const {initCardSettings}=await import('finance-fixture/ui/card-settings.js');
                      const d=new Date(),month=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,today=`${month}-${String(d.getDate()).padStart(2,'0')}`;
                      const past=`${d.getFullYear()-1}-01-01`,next=`${d.getFullYear()+1}-01-01`;
                      const yesterday=new Date(d.getFullYear(),d.getMonth(),d.getDate()-1),tomorrow=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).toLocaleDateString('sv-SE');
                      const data=emptyAssets();data.birthMonth=`${d.getFullYear()-25}-01`;
                      data.snapshots=[{id:'cash-test',accountId:'cash-savings',balance:100000,observedAt:`${today}T00:00:00Z`},{id:'nisa-test',accountId:'nisa',balance:200000,observedAt:`${today}T00:00:00Z`}];
                      data.recurring=[{id:'income-test',name:'定期入金テスト',kind:'income',amount:10000,fromAccountId:null,toAccountId:'cash-savings',frequency:'monthly',dayOfMonth:25,monthOfYear:null,weekday:null,startOn:past,endOn:null,enabled:true,categoryId:null}];
                      data.fixedCosts=[{id:'normal-cost',name:'通常契約',payment:'card',cardId:'rakuten-mizuho',merchantKey:null,categoryId:null,frequency:'monthly',dayOfMonth:25,monthOfYear:null,weekday:null,startOn:past,endOn:null,amount:1500,priceKind:'fixed',pricing:[{effectiveOn:past,amount:1500}],pauses:[],note:'',updatedAt:new Date().toISOString()},
                      {id:'future-cost',name:'将来契約',payment:'cash',cardId:null,merchantKey:null,categoryId:null,frequency:'yearly',dayOfMonth:yesterday.getDate(),monthOfYear:yesterday.getMonth()+1,weekday:null,startOn:past,endOn:null,amount:3000,priceKind:'fixed',pricing:[{effectiveOn:past,amount:2000},{effectiveOn:tomorrow,amount:3000}],pauses:[],note:'',updatedAt:new Date().toISOString()}];
                      data.cardPreferences={'rakuten-mizuho':{name:'テストカード',pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:next,ratePercent:1}]}};
                      data.cardRecurringDecisions={'rakuten-mizuho|test-merchant':{cardId:'rakuten-mizuho',merchant:'test-merchant',label:'対象外テスト',amount:1000,frequency:'monthly',state:'ignored',updatedAt:new Date().toISOString()}};
                      const records=[];const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],readonlyRecords:()=>structuredClone(records),
                        async upsertFixedCost(entry,decision){data.fixedCosts.push(structuredClone(entry));if(decision)data.cardRecurringDecisions[cardRecurringKey(decision.cardId,decision.merchant)]=structuredClone(decision);}};
                      const source=()=>vault.unlocked?{assets:vault.assetSettings(),records:vault.readonlyRecords(),rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}}:null;
                      const show=id=>{for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!==id);document.getElementById(id).classList.remove('hidden');};
                      const subs=initSubscriptions({source,vault:()=>vault,onSaved:()=>{},openAccountSettings:()=>{}});
                      const accounts=initAssetsSettings(()=>vault,()=>[],()=>{},()=>{});
                      const forecast=initFutureProjection(source);const cards=initCardSettings(()=>vault,()=>{});
                      const home=initHome({source,navigate(destination){if(destination==='subscription-candidates'){subs.selectCandidates();show('subscriptions-view');subs.render();}}});
                      window.polish3={show,subs,accounts,forecast,cards,
                        candidateNotice(){for(let i=4;i>=1;i--){const p=new Date(d.getFullYear(),d.getMonth()-i,1).toLocaleDateString('sv-SE').slice(0,7);records.push({id:'candidate-'+i,statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:p+'-27',statedTotal:1200,confirmation:'confirmed',warnings:[],rows:[{id:'candidate-row-'+i,usedOn:p+'-02',merchant:'CANDIDATE SERVICE',amount:1200}]}});}show('home-view');home.render();},
                        historicalCharge(){const prior=new Date(d.getFullYear(),d.getMonth()-1,1).toLocaleDateString('sv-SE').slice(0,7);
                          data.fixedCosts.push({...data.fixedCosts[0],id:'historical-charge',name:'料金改定テスト',merchantKey:cardRecurringKey('rakuten-mizuho','HISTORIC SERVICE'),amount:2000,pricing:[{effectiveOn:past,amount:1500},{effectiveOn:month+'-01',amount:2000}]});
                          records.push({id:'historical-bill',statement:{provider:'rakuten',cardId:'rakuten-mizuho',sourceKind:'paste',sourceName:'synthetic',billingMonth:prior,paymentDate:prior+'-27',statedTotal:1500,confirmation:'confirmed',warnings:[],rows:[{id:'historical-row',usedOn:prior+'-02',merchant:'HISTORIC SERVICE',amount:1500}]}});subs.render();},
                        alterCharge(){records[0].statement.statedTotal=1700;records[0].statement.rows[0].amount=1700;subs.render();},
                        clearCharge(){data.fixedCosts.pop();records.length=0;subs.render();},lock(){vault.unlocked=false;accounts.reset();forecast.reset();cards.reset();subs.reset();}};
                      show('subscriptions-view');subs.render();
                    }''')
                    normal=page.locator('.fixed-cost-item').filter(has_text='通常契約')
                    self.assertNotIn('変更予定：',normal.inner_text())
                    self.assertNotIn('月額換算',normal.inner_text())
                    self.assertNotIn('利用中',normal.inner_text())
                    self.assertIn('毎月25日',normal.inner_text())
                    self.assertEqual(page.locator('.fixed-cost-metric').count(),2)
                    geometry=normal.evaluate('e=>{const a=e.querySelector(".fixed-cost-item-actions").getBoundingClientRect(),p=e.querySelector(".fixed-cost-item-price").getBoundingClientRect();return {align:Math.abs(a.right-p.right),above:a.top<p.top}}')
                    self.assertLessEqual(geometry['align'],2);self.assertTrue(geometry['above'])
                    self.assertTrue(page.locator('.fixed-cost-registered-item').evaluate_all("rows=>rows.every(r=>Math.abs(r.querySelector('.fixed-cost-item-info').getBoundingClientRect().top-r.querySelector('.fixed-cost-item-actions').getBoundingClientRect().top)<2)"))
                    normal.get_by_role('button',name='詳細・編集').click()
                    detail=page.locator('.fixed-cost-dialog[open]');self.assertNotIn('支払条件の変更履歴',detail.inner_text());self.assertNotIn('料金変更履歴',detail.inner_text())
                    detail.get_by_role('button',name='閉じる').click()
                    page.evaluate('polish3.historicalCharge()')
                    historic=page.locator('.fixed-cost-item').filter(has_text='料金改定テスト')
                    self.assertIn('2,000円',historic.inner_text())
                    self.assertNotIn('差額',historic.inner_text())
                    self.assertNotIn('最新の請求実績',historic.inner_text())
                    historic.get_by_role('button',name='詳細・編集').click()
                    self.assertIn('最新の請求実績',detail.inner_text());self.assertIn('1,500円',detail.inner_text());self.assertNotIn('確認済み明細の請求履歴',detail.inner_text())
                    detail.get_by_role('button',name='閉じる').click()
                    page.evaluate('polish3.alterCharge()')
                    self.assertIn('差額 +200円',historic.inner_text())
                    page.evaluate('polish3.clearCharge()')
                    future=page.locator('.fixed-cost-item').filter(has_text='将来契約')
                    self.assertIn('変更予定：3,000円',future.inner_text())
                    page.evaluate('window.polish3.candidateNotice()')
                    page.locator('#home-content').get_by_role('button',name='定期支出の候補が1件あります').click()
                    self.assertEqual(page.get_by_role('button',name='検出候補 1').get_attribute('aria-pressed'),'true')
                    self.assertTrue(page.locator('.fixed-cost-item').filter(has_text='CANDIDATE SERVICE').is_visible())
                    page.get_by_role('button',name='対象外 1').click();ignored=page.locator('.fixed-cost-item').filter(has_text='対象外テスト');self.assertIn('テストカード',ignored.inner_text());self.assertNotIn('rakuten-mizuho',ignored.inner_text())
                    page.get_by_role('button',name='検出候補 1').click()
                    page.locator('.fixed-cost-item').filter(has_text='CANDIDATE SERVICE').get_by_role('button',name='登録',exact=True).click()
                    method=detail.locator('[name=method]');card=detail.locator('[name=cardId]');merchant=detail.locator('[name=merchant]')
                    self.assertTrue(method.is_disabled());self.assertTrue(card.is_enabled());self.assertEqual(card.input_value(),'rakuten-mizuho')
                    self.assertTrue(merchant.evaluate('e=>e.readOnly'));self.assertNotIn('確認済み明細の請求履歴',detail.inner_text())
                    for theme in ('light','dark'):
                        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                        styles=detail.evaluate("e=>['method','cardId','merchant'].map(n=>{const s=getComputedStyle(e.querySelector('[name='+n+']'));return [s.backgroundColor,s.color,s.backgroundImage,s.opacity]})")
                        self.assertNotEqual(styles[0][0],styles[1][0]);self.assertNotEqual(styles[0][1],styles[1][1]);self.assertEqual(styles[0][2],'none');self.assertNotEqual(styles[1][2],'none');self.assertEqual(styles[0][3],'1');self.assertEqual(styles[0][0],styles[2][0])
                    page.evaluate("document.documentElement.dataset.theme='light'")
                    card.select_option('amazon');self.assertIn('検出元のカードの候補は対象外',detail.inner_text())
                    card.select_option('rakuten-mizuho');self.assertNotIn('検出元のカードの候補は対象外',detail.inner_text())
                    card.select_option('amazon');detail.get_by_role('button',name='保存',exact=True).click();detail.wait_for(state='hidden')
                    self.assertEqual(page.get_by_role('button',name='検出候補 0').get_attribute('aria-pressed'),'true')
                    page.get_by_role('button',name='登録済み 3').click();self.assertTrue(page.locator('.fixed-cost-item').filter(has_text='CANDIDATE SERVICE').is_visible())
                    page.evaluate("polish3.show('assets-page');polish3.accounts.render()")
                    self.assertEqual(page.locator('.assets-balance-future').count(),0)
                    self.assertNotIn('来月末',page.locator('#assets-page').inner_text())
                    self.assertIn('毎月25日',page.locator('#assets-recurring-list').inner_text())
                    self.assertEqual(page.locator('#assets-recurring-list .assets-recurring-dates').count(),0)
                    page.evaluate("polish3.show('future-view');polish3.forecast.render()")
                    self.assertTrue(page.locator('#future-scenario-hint').is_visible());self.assertIn('10,000円',page.locator('#future-scenario-hint').inner_text())
                    scenario=page.locator('#future-scenario-accordion');scenario.locator('summary').click()
                    self.assertTrue(scenario.evaluate('e=>Math.abs(e.getBoundingClientRect().width-e.parentElement.clientWidth)<=3&&e.scrollWidth<=e.clientWidth+2'))
                    if width==1100:
                        self.assertTrue(page.locator('.future-planner').evaluate('e=>Math.abs(e.children[0].getBoundingClientRect().height-e.children[1].getBoundingClientRect().height)<3'))
                        self.assertTrue(page.locator('.future-planner').evaluate('e=>getComputedStyle(e.children[0]).justifyContent==="flex-start"&&Math.abs(e.children[0].firstElementChild.getBoundingClientRect().top-e.children[1].firstElementChild.getBoundingClientRect().top)<2'))
                    scenario.locator('summary').click()
                    annual=page.locator('.future-annual-list');self.assertFalse(annual.locator('table').is_visible());annual.locator('summary').click();self.assertTrue(annual.locator('table').is_visible())
                    page.wait_for_function("document.querySelector('.future-annual-list').open")
                    page.evaluate('polish3.forecast.render()');self.assertTrue(annual.locator('table').is_visible())
                    page.evaluate("polish3.show('settings-view');document.querySelector('.settings-card-disclosure').open=true")
                    page.locator('#settings-nisa-panel summary').click()
                    self.assertTrue(page.locator('#assets-nisa-link-form').evaluate('e=>e.scrollWidth<=e.clientWidth+2'))
                    nisa=page.locator('.assets-nisa-fields').evaluate("""e=>{const r=id=>{const t=document.getElementById(id).getBoundingClientRect();return {top:t.top,bottom:t.bottom,right:t.right,height:t.height}};return {card:r('assets-nisa-card'),merchant:r('assets-nisa-merchant'),save:r('assets-nisa-save'),width:e.clientWidth,scroll:e.scrollWidth}}""")
                    self.assertLessEqual(nisa['scroll'],nisa['width']+2)
                    self.assertAlmostEqual(nisa['save']['height'],nisa['merchant']['height'],delta=2)
                    if width==1100:
                        self.assertAlmostEqual(nisa['card']['bottom'],nisa['merchant']['bottom'],delta=2);self.assertAlmostEqual(nisa['save']['bottom'],nisa['merchant']['bottom'],delta=2)
                        self.assertAlmostEqual(nisa['save']['height'],nisa['merchant']['height'],delta=2)
                    page.locator('#settings-payroll-disclosure summary').click()
                    for theme in ['light','dark']:
                        page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                        self.assertTrue(page.locator('.settings-payroll-content').evaluate("""e=>[...e.children,...e.querySelectorAll('.settings-payroll-metrics>div')].every(x=>getComputedStyle(x).backgroundColor==='rgba(0, 0, 0, 0)'&&x.scrollWidth<=x.clientWidth+2)"""))
                        self.assertTrue(page.locator('.settings-payroll-content').evaluate("""e=>{const forms=[...e.querySelectorAll('form')];return forms.length===2&&forms.every(f=>{const field=f.querySelector('input,select').getBoundingClientRect(),button=f.querySelector('[type=submit]').getBoundingClientRect();return Math.abs(field.height-button.height)<2&&(button.top>=field.bottom-2||Math.abs(field.bottom-button.bottom)<2)})}"""))
                        self.assertTrue(page.locator('#settings-card-save').evaluate("e=>getComputedStyle(e).backgroundColor===getComputedStyle(document.querySelector('#assets-birth-save')).backgroundColor"))
                        self.assertTrue(page.locator('#assets-birth-save').evaluate("e=>e.classList.contains('save-action')&&document.querySelector('#settings-card-save').classList.contains('save-action')"))
                    page.evaluate("document.documentElement.dataset.theme='light'")

                    self.assertTrue(page.locator('#assets-nisa-disable').evaluate('e=>Math.abs(e.getBoundingClientRect().right-e.parentElement.getBoundingClientRect().right)<3'))
                    management=page.locator('#cloud-advanced');self.assertTrue(page.locator('#cloud-rotate-form').is_visible());self.assertFalse(management.locator('#cloud-cleanup-scan').is_visible());management.locator('summary').first.click();self.assertTrue(management.locator('#cloud-cleanup-scan').is_visible())
                    self.assertIn('旧版のタブを閉じてください',management.inner_text())
                    page.locator('input[name="card-setting-selected"][value="rakuten-mizuho"]').check()
                    self.assertEqual(page.locator('.card-setting-rate-history').count(),0)
                    self.assertEqual(page.locator('.card-setting-rate-edit:visible input[type=number]').input_value(),'1')
                    self.assertIn('変更予定の還元率',page.locator('.card-setting-rate-edit:visible').inner_text())
                    if width==1100:
                        self.assertTrue(page.locator('.card-setting-secondary-fields:visible').evaluate('e=>Math.abs(e.querySelector(".card-setting-rate-edit input").getBoundingClientRect().top-e.querySelector(".card-setting-reminder select").getBoundingClientRect().top)<2'))
                    history=page.locator('.card-setting-rate-history-list:visible');history.locator('summary').click();self.assertIn('2.0%',history.inner_text());self.assertIn('1.0%',history.inner_text());history.locator('summary').click()
                    self.assertFalse(page.locator('.card-setting-rate-history-list:visible .card-setting-rate-history-line').first.is_visible())
                    page.evaluate('polish3.lock()');self.assertEqual(page.locator('#future-scenario-hint').text_content(),'');self.assertEqual(page.locator('#assets-recurring-list').text_content(),'');self.assertEqual(page.locator('.card-setting-rate-history').count(),0)
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_recent_merchant_picker_grouping_and_amount(self):
        html=self.offline_document(import_workspace=True)
        for width,theme in ((1100,'light'),(390,'dark'),(320,'light')):
            with self.subTest(width=width,theme=theme):
                context=self.browser.new_context(viewport={'width':width,'height':850},color_scheme=theme)
                try:
                    page=context.new_page();page.set_default_timeout(6000);errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      await import('finance-fixture/main.js');
                      const record=(id,cardId,rows)=>({id,statement:{cardId,billingMonth:'2026-11',rows}});
                      const row=(merchant,usedOn,amount)=>({merchant,usedOn,amount});
                      const records=[record('a','smbc-nl',[row('DEMO SHOP','2026-11-20',1200),row('DEMO SHOP','2026-11-10',1100),row('REGISTERED SHOP','2026-11-20',300),row('PARTIAL SHOP','2026-11-20',900)]),record('b','recruit-jcb',[row('ＤＥＭＯ ＳＨＯＰ','2026-11-15',800),row('PARTIAL SHOP','2026-11-18',650)])];
                      const rule=(id,pattern,cardId)=>({id,pattern,cardId,mode:'exact',displayName:pattern,priority:100,enabled:true,categoryId:null});
                      financeImportTest.rulesPicker(records,[rule('r1','REGISTERED SHOP',null),rule('r2','PARTIAL SHOP','smbc-nl')]);
                    }''')
                    page.locator('#rules-pick-merchant').click();picker=page.locator('#recent-merchants-dialog')
                    items=picker.locator('.recent-merchant-item');self.assertEqual(items.count(),2)
                    self.assertEqual(items.filter(has_text='DEMO SHOP').inner_text(),'DEMO SHOP\n2026/11/20 他2件')
                    self.assertEqual(items.filter(has_text='REGISTERED SHOP').count(),0)
                    items.filter(has_text='DEMO SHOP').click();evidence=page.locator('#rule-history-evidence')
                    self.assertTrue(evidence.is_visible());self.assertIn('1,200円',evidence.inner_text());self.assertFalse(page.locator('#rule-fixed-cost').is_checked())
                    page.locator('#rule-card').select_option('recruit-jcb');self.assertIn('800円',evidence.inner_text())
                    page.locator('#rule-fixed-cost').check();self.assertTrue(evidence.is_visible());self.assertIn('800円',evidence.inner_text())
                    page.locator('#rule-reset').click();self.assertFalse(evidence.is_visible())
                    page.locator('#rules-pick-merchant').click();items.filter(has_text='PARTIAL SHOP').click();self.assertEqual(page.locator('#rule-card').input_value(),'recruit-jcb');self.assertIn('650円',evidence.inner_text())
                    page.locator('#rule-pattern').fill('OTHER');self.assertFalse(evidence.is_visible())
                    self.assertTrue(page.locator('.rules-list-tools').evaluate('e=>{const a=e.querySelector("button").getBoundingClientRect(),b=e.querySelector("span").getBoundingClientRect();return a.right<=b.left&&Math.abs(a.top+a.height/2-b.top-b.height/2)<3&&e.scrollWidth<=e.clientWidth+2}'))
                    self.assertEqual(errors,[])
                finally:context.close()

    def test_fixed_cost_candidate_decision_feedback(self):
        html=self.offline_document()
        for width,theme in ((1100,'light'),(390,'dark'),(320,'light')):
            with self.subTest(width=width,theme=theme):
                context=self.browser.new_context(viewport={'width':width,'height':760},color_scheme=theme)
                try:
                    page=context.new_page();page.set_default_timeout(6000);errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
                      const d=new Date(),records=[];for(let i=4;i>=1;i--){const p=new Date(d.getFullYear(),d.getMonth()-i,1).toLocaleDateString('sv-SE').slice(0,7);records.push({id:'feedback-'+i,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:p+'-27',statedTotal:1200,confirmation:'confirmed',warnings:[],rows:[{id:'feedback-row-'+i,usedOn:p+'-02',merchant:'SYNTHETIC SERVICE',amount:1200}]}});}
                      const assets=emptyAssets(),writes=[];let release;
                      const vault={unlocked:true,async setCardRecurringDecision(key,decision){writes.push(decision);await new Promise((resolve,reject)=>release={resolve,reject});if(decision)(assets.cardRecurringDecisions??={})[key]=decision;else delete assets.cardRecurringDecisions[key];}};
                      const source=()=>({assets,records,rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}});
                      const subs=initSubscriptions({source,vault:()=>vault,onSaved:()=>{},openAccountSettings:()=>{},openCardRule:()=>{}});
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!=='subscriptions-view');
                      document.getElementById('subscriptions-view').classList.remove('hidden');subs.selectCandidates();subs.render();
                      window.candidateFeedback={writes,ok:()=>release.resolve(),fail:()=>release.reject(Error('synthetic failure'))};
                    }''')
                    toast=page.locator('#toast');exclude=page.get_by_role('button',name='候補から除外',exact=True)
                    exclude.click();self.assertTrue(exclude.is_disabled());self.assertEqual(toast.get_attribute('data-kind'),'working')
                    exclude.evaluate('b=>b.click()');self.assertEqual(page.evaluate('candidateFeedback.writes.length'),1)
                    page.evaluate('candidateFeedback.fail()');page.wait_for_function('document.querySelector("#toast").dataset.kind==="bad"');self.assertTrue(exclude.is_enabled())
                    exclude.click();page.evaluate('candidateFeedback.ok()');page.wait_for_function('document.querySelector("#toast").dataset.kind==="good"')
                    self.assertEqual(exclude.count(),0);page.get_by_role('button',name='対象外',exact=False).click()
                    restore=page.get_by_role('button',name='候補に戻す',exact=True);restore.click();self.assertTrue(restore.is_disabled());self.assertEqual(toast.get_attribute('data-kind'),'working')
                    restore.evaluate('b=>b.click()');self.assertEqual(page.evaluate('candidateFeedback.writes.length'),3)
                    page.evaluate('candidateFeedback.fail()');page.wait_for_function('document.querySelector("#toast").dataset.kind==="bad"');self.assertTrue(restore.is_enabled())
                    restore.click();page.evaluate('candidateFeedback.ok()');page.wait_for_function('document.querySelector("#toast").dataset.kind==="good"');self.assertEqual(restore.count(),0)
                    self.assertEqual(errors,[])
                    self.assertEqual(page.locator('.fixed-cost-registration-actions button').count(),2)
                finally:context.close()

    def test_rule_fixed_cost_actual_price_and_candidate_navigation(self):
        html=self.offline_document()
        for width,theme in ((1100,'light'),(390,'dark'),(320,'light')):
            with self.subTest(width=width,theme=theme):
                context=self.browser.new_context(viewport={'width':width,'height':760},color_scheme=theme)
                try:
                    page=context.new_page();page.set_default_timeout(6000);errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
                      const {prepareCardFixedRule}=await import('finance-fixture/fixed-costs/rule-fixed-costs.js');
                      const d=new Date(),today=d.toLocaleDateString('sv-SE');
                      const records=[];for(let i=4;i>=1;i--){const p=new Date(d.getFullYear(),d.getMonth()-i,1).toLocaleDateString('sv-SE').slice(0,7);records.push({id:'candidate-'+i,statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',billingMonth:p,paymentDate:p+'-27',statedTotal:1200,confirmation:'confirmed',warnings:[],rows:[{id:'candidate-row-'+i,usedOn:p+'-02',merchant:'SYNTHETIC SERVICE',amount:1200}]}});}
                      const rules=[{id:'synthetic-rule',pattern:'SYNTHETIC SERVICE',mode:'exact',displayName:'合成サービス',cardId:'smbc-nl',enabled:true,priority:100,categoryId:'food'}];
                      const assets=emptyAssets(),source=()=>({assets,records,rules,categories:[{id:'food',name:'食費'}],payroll:{ready:false,entries:[],syncedAt:null}});
                      const subs=initSubscriptions({source,vault:()=>({unlocked:true}),onSaved:()=>{},openAccountSettings:()=>{},openCardRule:target=>{window.ruleTarget=target??{};if(target?.candidate){const draft=prepareCardFixedRule(source(),today,target);rules[0]={...draft.rule,fixedCost:draft.fixed};subs.render();}}});
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!=='subscriptions-view');
                      document.getElementById('subscriptions-view').classList.remove('hidden');subs.selectCandidates();subs.render();
                      window.fixedRuleTest={show:()=>{subs.render();},change:()=>{const last=records.at(-1);last.statement.statedTotal=2500;last.statement.rows[0].amount=2500;subs.render();}};
                    }''')
                    page.get_by_role('button',name='登録',exact=True).click()
                    self.assertEqual(page.evaluate('window.ruleTarget.candidate.cardId'),'smbc-nl')
                    page.get_by_role('button',name='登録済み',exact=False).click()
                    item=page.locator('.fixed-cost-item').filter(has_text='合成サービス')
                    self.assertIn('1,200',item.inner_text());self.assertIn('食費',item.inner_text())
                    item.get_by_role('button',name='ルールを編集').click()
                    self.assertEqual(page.evaluate('window.ruleTarget.rule.id'),'synthetic-rule')
                    self.assertEqual(page.locator('.fixed-cost-dialog[open]').count(),0)
                    page.evaluate('window.fixedRuleTest.change()');self.assertIn('2,500',item.inner_text())
                    self.assertEqual(errors,[])
                finally:
                    context.close()

    def test_future_fixed_cost_initial_terms_correction(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,validateAssets}=await import('finance-fixture/cloud/assets.js');
                      const {applyContractEdit}=await import('finance-fixture/fixed-costs/contract-edit.js');
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
                      const now=new Date(),today=now.toLocaleDateString('sv-SE'),start=`${now.getFullYear()+1}-01-01`;
                      let data=emptyAssets();data.recurring=[{id:'future-contract-demo',kind:'expense',name:'開始前テスト',amount:1000,fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:5,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:null,enabled:true}];
                      const writes=[];
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],async editContract(expected,edit){
                        const entry=applyContractEdit(expected,edit,today);const next=structuredClone(data);
                        next.recurring=next.recurring.filter(x=>x.id!==entry.id);next.fixedCosts=(next.fixedCosts??[]).filter(x=>x.id!==entry.id);
                        if('kind' in entry)next.recurring.push(entry);else next.fixedCosts.push(entry);
                        if(edit.payment)next.format='finance-assets-v2';data=validateAssets(next);writes.push({edit:structuredClone(edit),entry:structuredClone(entry)});
                      }};
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!=='subscriptions-view');
                      const source=()=>({assets:vault.assetSettings(),records:[],rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}});
                      const ui=initSubscriptions({source,vault:()=>vault,onSaved:()=>{},openAccountSettings:()=>{}});ui.render();window.initialCost={ui,writes,start};
                    }''')
                    cost=page.locator('.fixed-cost-item').filter(has_text='開始前テスト');cost.get_by_role('button',name='詳細・編集').click()
                    form=page.locator('.fixed-cost-form');date=form.locator('[name="paymentDate"]');start=page.evaluate('initialCost.start')
                    self.assertTrue(form.locator('[name="startOn"]').evaluate('e=>e.readOnly'))
                    form.locator('[name="method"]').select_option('card');form.locator('[name="cardId"]').select_option('smbc-nl');form.locator('[name="merchant"]').fill('SYNTHETIC SERVICE')
                    self.assertEqual(date.input_value(),start);self.assertEqual(date.get_attribute('min'),start)
                    form.locator('[name="amount"]').fill('2300');form.get_by_role('button',name='保存',exact=True).click();page.wait_for_function('initialCost.writes.length===1')
                    saved=page.evaluate('initialCost.writes[0].entry');self.assertEqual(saved['id'],'future-contract-demo');self.assertEqual(saved['payment'],'card');self.assertEqual(saved['amount'],2300);self.assertNotIn('paymentHistory',saved)
                    cost.get_by_role('button',name='詳細・編集').click();form.locator('[name="method"]').select_option('bank');form.locator('[name="accountId"]').select_option('mizuho-bank')
                    self.assertEqual(date.input_value(),start);form.get_by_role('button',name='保存',exact=True).click();page.wait_for_function('initialCost.writes.length===2')
                    saved=page.evaluate('initialCost.writes[1].entry');self.assertEqual(saved['kind'],'expense');self.assertEqual(saved['fromAccountId'],'mizuho-bank');self.assertEqual(saved['id'],'future-contract-demo');self.assertNotIn('paymentHistory',saved);self.assertEqual(errors,[])
                finally:context.close()

    def test_future_point_rate_revision_and_cancellation(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[];page.set_default_timeout(6000)
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets,validateCardPreferences}=await import('finance-fixture/cloud/assets.js');
                      const {initCardSettings}=await import('finance-fixture/ui/card-settings.js');
                      const now=new Date(),future=`${now.getFullYear()+2}-01-01`,earlier=`${now.getFullYear()+1}-01-01`;
                      const data=emptyAssets();data.cardPreferences={'rakuten-mizuho':{pointRatePercent:1,pointRateHistory:[{effectiveOn:'1900-01-01',ratePercent:2},{effectiveOn:future,ratePercent:1}]}};
                      const writes=[];const vault={unlocked:true,assetSettings:()=>structuredClone(data),merchantRules:()=>[],fixedCostMigrations:()=>[],async setCardConfiguration(prefs,debits){data.cardPreferences=validateCardPreferences(prefs);data.cardDebitAccounts=debits;writes.push(structuredClone(data.cardPreferences));}};
                      for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!=='settings-view');
                      document.getElementById('settings-card-disclosure').open=true;
                      const ui=initCardSettings(()=>vault,()=>{});window.pointSchedule={writes,future,earlier,ui};
                    }''')
                    page.locator('input[name="card-setting-selected"][value="rakuten-mizuho"]').check()
                    panel=page.locator('.card-setting-item:visible');date=panel.locator('.card-setting-rate-edit input[type=date]');operation=panel.get_by_label('変更予定の操作')
                    earlier=page.evaluate('pointSchedule.earlier');date.fill(earlier)
                    self.assertTrue(page.evaluate('pointSchedule.ui.isDirty()'))
                    page.locator('#settings-card-save').click()
                    page.wait_for_function('pointSchedule.writes.length===1')
                    saved=page.evaluate("pointSchedule.writes[0]['rakuten-mizuho']")
                    self.assertEqual(saved['pointRateHistory'][-1],{'effectiveOn':earlier,'ratePercent':1})
                    operation.select_option('cancel');self.assertTrue(date.is_disabled())
                    page.locator('#settings-card-save').click();page.wait_for_function('pointSchedule.writes.length===2')
                    saved=page.evaluate("pointSchedule.writes[1]['rakuten-mizuho']")
                    self.assertEqual(saved['pointRatePercent'],2);self.assertEqual(len(saved['pointRateHistory']),1)
                    self.assertEqual(panel.get_by_label('変更予定の操作').count(),0);self.assertEqual(errors,[])
                finally:context.close()

    def test_manual_salary_summary_and_actual_replacement(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort())
                    page.set_content(html)
                    page.evaluate('''async()=>{
                      for(const view of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"]'))view.classList.toggle('hidden',view.id!=='summary-view');
                      const pay=(id,job,amount)=>({id,employerId:job,job,paidOn:'2026-11-27',payPeriod:'2026-11',netPay:amount,grossPay:null,taxablePay:null,currency:'JPY',kind:'salary',revision:1});
                      const rec=(id,name,amount)=>({id,name,amount,kind:'income',fromAccountId:null,toAccountId:'rakuten-bank',frequency:'monthly',dayOfMonth:27,monthOfYear:null,weekday:null,startOn:'2026-11-01',endOn:null,categoryId:null,enabled:true});
                      window.salarySource={records:[],rules:[],categories:[],assets:{nisaCardRule:null,recurring:[rec('main-plan','本業給与',190000),rec('side-plan','副業給与',20000)],oneTime:[],snapshots:[],payrollDepositAccount:'rakuten-bank',cardNoUseMonths:['2026-11']},payroll:{ready:true,syncedAt:1000,entries:[pay('actual-main','main',190000)]},currentPeriod:'2026-11'};
                      const ui=await import('finance-fixture/ui/monthly-summary.js');
                      window.salarySummary=ui.initMonthlySummary({source:()=>window.salarySource,openRecord:()=>{},openDrilldown:()=>{}});
                      window.salarySummary.setPeriod('2026-11');
                      window.addActualSide=()=>{window.salarySource.payroll.entries.push(pay('actual-side','side',23000));window.salarySummary.render();};
                    }''')
                    metric=page.locator('#monthly-content .monthly-metric').first
                    self.assertEqual(metric.locator('.monthly-metric-label').inner_text(),'収入')
                    self.assertIn('210,000円',metric.inner_text())
                    self.assertIn('入金予定含む',metric.inner_text())
                    self.assertNotIn('給与見込みを含む',metric.inner_text())
                    # The compact KPI keeps the status; the detailed planned amount lives in the income breakdown.
                    incomes=page.locator('#monthly-content .monthly-panel').filter(has=page.get_by_role('heading',name='収入内訳',exact=True))
                    planned=incomes.locator('.monthly-line').filter(has_text='副業給与')
                    self.assertEqual(planned.count(),1)
                    self.assertIn('入金予定',planned.inner_text())
                    self.assertEqual(planned.locator('strong').inner_text(),'20,000円')
                    self.assertNotIn('20,000円',metric.inner_text())
                    page.evaluate('window.addActualSide()')
                    self.assertIn('213,000円',metric.inner_text())
                    self.assertNotIn('入金予定含む',metric.inner_text())
                    self.assertEqual(planned.count(),0)
                    actual=incomes.locator('.monthly-line').filter(has_text='副業 · 給与')
                    self.assertEqual(actual.count(),1)
                    self.assertEqual(actual.locator('strong').inner_text(),'23,000円')
                    self.assertNotIn('定期入金',metric.inner_text())
                    self.assertNotIn('給与実績と重なる定期収入',page.locator('#monthly-content').inner_text())
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_month_summary_ranking_uses_real_drilldown_filter(self):
        page,context,errors=self.create_page()
        try:
            self.set_section(page,'summary')
            page.evaluate('''async()=>{
              const row=(id,merchant,amount)=>({id,usedOn:'2026-10-09',merchant,amount});
              const rows=[row('food-1','MARKET',2500),row('software-1','CLOUD',900),row('unknown','OTHER',100)];
              const rec={id:'statement-1',statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',paymentDate:'2026-11-27',billingMonth:'2026-10',statedTotal:3500,confirmation:'confirmed',warnings:[],rows}};
              window.fixtures={records:[rec],rules:[
                {id:'r-food',pattern:'MARKET',mode:'contains',displayName:'スーパー',cardId:null,enabled:true,priority:100,categoryId:'food'},
                {id:'r-app',pattern:'CLOUD',mode:'contains',displayName:'クラウド',cardId:null,enabled:true,priority:100,categoryId:'digital'},
              ],categories:[{id:'food',name:'食費',color:'orange'},{id:'digital',name:'サブスク',color:'violet'}],
              assets:{nisaCardRule:null,recurring:[],oneTime:[],snapshots:[]},payroll:{ready:false,syncedAt:null,entries:[]},currentPeriod:'2026-11'};
              window.navigationCalls=[];
              const ui=await import('/dist/src/ui/monthly-summary.js');
              window.monthlyE2E=ui.initMonthlySummary({source:()=>window.fixtures,openRecord:()=>{},openDrilldown:request=>window.navigationCalls.push(request)});
              window.monthlyE2E.setPeriod('2026-11');
            }''')
            page.get_by_role('button',name='食費（1件）').click()
            call=page.evaluate('window.navigationCalls.at(-1)')
            self.assertEqual(call,{'dimension':'category','value':'food','label':'食費','periods':['2026-11']})
            page.evaluate('''async()=>{
              const {analysisDrilldownBreakdown}=await import('/dist/src/ui/analysis-drilldown.js');
              window.lastBreakdown=analysisDrilldownBreakdown(window.fixtures,window.navigationCalls.at(-1));
            }''')
            self.assertEqual(page.evaluate('window.lastBreakdown.total'),2500)
            page.get_by_role('button',name='1. スーパー（1件）').click()
            call=page.evaluate('window.navigationCalls.at(-1)')
            self.assertEqual(call,{'dimension':'merchant','value':'スーパー','label':'スーパー','periods':['2026-11']})
            self.assertFalse(errors,errors)
        finally:
            context.close()

    def test_month_reports_year_selector_limits_months(self):
        page,context,errors=self.create_page()
        try:
            self.set_section(page,'reports')
            page.evaluate('''async()=>{
              const months=[];
              for(const y of [2024,2025,2026])for(let m=1;m<=12;m++)months.push(`${y}-${String(m).padStart(2,'0')}`);
              const vault={unlocked:true,listArchivedMonths:async()=>months,loadArchivedReport:async()=>null};
              const mod=await import('/dist/src/ui/monthly-reports.js');
              window.reportE2E=mod.initMonthlyReports({source:()=>null,vault:()=>vault,openMonth:()=>{}});
              window.reportE2E.openPeriod('2026-11');window.reportE2E.render();
            }''')
            year=page.get_by_role('combobox',name='保存済みレポートの年')
            year.wait_for()
            self.assertEqual(year.input_value(),'2026')
            self.assertEqual(page.locator('.reports-year-months button').count(),12)
            year.select_option('2024')
            self.assertEqual(page.get_by_role('combobox',name='保存済みレポートの年').input_value(),'2024')
            self.assertEqual(page.locator('.reports-year-months button').count(),12)
            self.assertEqual(page.locator('button.reports-period-button.selected').count(),0)
            self.assertTrue(page.evaluate('document.activeElement?.classList.contains("reports-year-select")'))
            page.locator('.reports-year-months').get_by_role('button',name='3月').click()
            page.wait_for_function("document.querySelector('#reports-content .reports-year-select')?.value === '2024'")
            self.assertEqual(page.locator('.reports-year-months .selected').inner_text(),'3月')
            self.assertFalse(errors,errors)
        finally:
            context.close()


    def test_card_only_manager_and_no_home_unclassified_notice(self):
        html=self.offline_document(import_workspace=True)
        for width,mobile in ((1100,False),(390,True),(320,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':850},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    report=page.evaluate('''async()=>{
                      await import('finance-fixture/main.js');
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {monthlyReport}=await import('finance-fixture/summary/monthly-summary.js');
                      const {initHome}=await import('finance-fixture/ui/home.js');
                      const now=new Date(),period=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
                      const records=[{id:'fixture-card',statement:{provider:'smbc',cardId:'smbc-nl',sourceKind:'paste',sourceName:'synthetic',paymentDate:period+'-27',billingMonth:period,statedTotal:1500,confirmation:'confirmed',warnings:[],rows:[{id:'unknown',usedOn:period+'-01',merchant:'CARD ONLY',amount:1000},{id:'known',usedOn:period+'-01',merchant:'CLASSIFIED',amount:500}]}}];
                      const assets=emptyAssets();assets.recurring=[{id:'bank-expense',name:'BANK ONLY',amount:2000,kind:'expense',fromAccountId:'rakuten-bank',toAccountId:null,frequency:'monthly',dayOfMonth:1,monthOfYear:null,weekday:null,startOn:period+'-01',endOn:null,categoryId:null,enabled:true}];
                      assets.oneTime=[{id:'once-expense',date:period+'-02',name:'ONCE ONLY',amount:3000,kind:'expense',status:'done',fromAccountId:'rakuten-bank',toAccountId:null,categoryId:null}];
                      const source={records,assets,rules:[{id:'known-rule',pattern:'CLASSIFIED',mode:'exact',displayName:'CLASSIFIED',cardId:null,enabled:true,priority:100,categoryId:'food'}],categories:[{id:'food',name:'食費',color:'orange'}],payroll:{ready:false,entries:[],syncedAt:null},currentPeriod:period};
                      financeImportTest.prepare(records);
                      for(const n of document.querySelectorAll('.workspace .content > :is(section,div)[id]'))n.classList.toggle('hidden',n.id!=='home-view');
                      const home=initHome({source:()=>source,navigate:()=>{}});home.render();
                      const homeActions=[...document.querySelectorAll('#home-content .home-action')].map(n=>n.textContent);
                      const data=monthlyReport(period,source);
                      financeImportTest.drilldown(source,{periods:[period],dimension:'category',value:'__unclassified',label:'未分類'});
                      window.cardOnlySource=source;
                      return {homeActions,unclassified:data.categories.find(c=>c.id==='__unclassified')?.amount,period};
                    }''')
                    self.assertEqual(report['unclassified'],6000,report)
                    self.assertFalse(any('未分類' in item for item in report['homeActions']),report)
                    self.assertTrue(any('Payroll' in item for item in report['homeActions']),report)
                    manager=page.locator('#manage-view');self.assertTrue(manager.is_visible())
                    self.assertIn('カード取引のみ表示 · 合計 1,000円',manager.locator('#manage-drilldown-description').inner_text())
                    self.assertNotIn(report['period'],manager.locator('#manage-drilldown-title').inner_text())
                    self.assertEqual(manager.locator('#manage-rows input[aria-label="利用先"]').evaluate_all('els=>els.map(e=>e.value)'),['CARD ONLY'])
                    for unwanted in ('BANK ONLY','ONCE ONLY','CLASSIFIED','分析の合計','対象金額の内訳'):
                        self.assertNotIn(unwanted,manager.inner_text())
                    for theme in ('light','dark'):
                        page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
                        self.assertLessEqual(manager.locator('#manage-drilldown').bounding_box()['x']+manager.locator('#manage-drilldown').bounding_box()['width'],width+1)
                    page.evaluate('financeImportTest.drilldown(cardOnlySource,null)')
                    self.assertFalse(manager.locator('#manage-drilldown').is_visible())
                    self.assertEqual(manager.locator('#manage-drilldown-description').text_content(),'')
                    self.assertCountEqual(manager.locator('#manage-rows input[aria-label="利用先"]').evaluate_all('els=>els.map(e=>e.value)'),['CARD ONLY','CLASSIFIED']);self.assertEqual(errors,[])
                finally:context.close()

    def test_cloud_gate_pending_and_recovery_action_styles(self):
        html=self.offline_document()
        for width,mobile in ((1100,False),(390,True)):
            with self.subTest(width=width):
                context=self.browser.new_context(viewport={'width':width,'height':800},is_mobile=mobile,has_touch=mobile)
                try:
                    page=context.new_page();page.set_content(html)
                    result=page.evaluate("""async()=>{
                      const {FINANCE_CLOUD_GATE_PAGES:pages,syncFinanceCloudGates:sync}=await import('finance-fixture/ui/cloud-gate.js');
                      const calls=[];const base={blocked:true,locked:true,checking:true,notice:{kind:'connected',message:''},onRetry:()=>calls.push('retry'),onReauthenticate:()=>calls.push('reauth'),onUnlock:()=>calls.push('unlock'),onSettings:()=>calls.push('settings')};
                      const panels=()=>pages.map(x=>document.getElementById(x.id).querySelector('.finance-cloud-gate-panel'));
                      sync(base);const connecting=panels().every(p=>p.children.length===1&&p.textContent==='OneDriveに接続中…');
                      const pendingStyles=[];for(const theme of ['light','dark']){document.documentElement.dataset.theme=theme;const style=getComputedStyle(panels()[0].querySelector('h2'));pendingStyles.push(style.fontSize==='14px'&&style.fontWeight==='600'&&style.color===getComputedStyle(document.getElementById('cloud-pending-status')).color);}
                      sync({...base,progress:'保管庫を復号中…'});const decrypting=panels().every(p=>p.children.length===1&&p.textContent==='保管庫を復号中…');
                      sync({...base,checking:false});const locked=panels().every(p=>p.querySelectorAll('button').length===2);panels()[0].querySelector('button').click();
                      sync({...base,checking:false,locked:false,notice:{kind:'network',message:'通信失敗'}});
                      const settings=document.getElementById('settings-view');settings.classList.remove('hidden');
                      const pendingStatus=document.getElementById('cloud-pending-status');pendingStatus.textContent='OneDriveに接続中…';
                      settings.classList.add('cloud-connection-pending');
                      const waiting=getComputedStyle(pendingStatus).display!=='none'&&['.cloud-primary-actions','.cloud-account-actions','.cloud-remember-controls','.cloud-rotate-panel','#settings-card-disclosure','#settings-payroll-disclosure','#settings-nisa-panel','#cloud-advanced','#activity-log-panel'].every(q=>getComputedStyle(settings.querySelector(q)).display==='none');
                      settings.classList.remove('cloud-connection-pending');
                      const restored=getComputedStyle(pendingStatus).display==='none'&&getComputedStyle(settings.querySelector('.cloud-primary-actions')).display!=='none'&&getComputedStyle(settings.querySelector('#settings-payroll-disclosure')).display!=='none'&&getComputedStyle(settings.querySelector('#activity-log-panel')).display!=='none';
                      const plain=document.createElement('button');plain.className='secondary-action';document.body.append(plain);
                      const styles=[];for(const theme of ['light','dark']){document.documentElement.dataset.theme=theme;const a=getComputedStyle(panels()[0].querySelector('button:last-child')),b=getComputedStyle(plain);styles.push(['color','backgroundColor','borderColor','borderRadius','fontSize'].every(k=>a[k]===b[k]));}
                      const buttons=[...panels()[0].querySelectorAll('button')];buttons.forEach(b=>b.click());
                      sync({...base,checking:false,locked:false});const missing=panels().every(p=>p.querySelectorAll('button').length===1);
                      sync({...base,blocked:false});const unlocked=pages.every(x=>!document.getElementById(x.id).querySelector('.finance-cloud-gate'));
                      return {connecting,decrypting,locked,waiting,restored,styles,pendingStyles,calls,missing,unlocked,payroll:!!document.getElementById('assets-payroll-connect'),menu:!!document.getElementById('nav-payroll')};
                    }""")
                    for key in ('connecting','decrypting','locked','waiting','restored','missing','unlocked','payroll'):self.assertTrue(result[key],result)
                    self.assertEqual(result['styles'],[True,True]);self.assertEqual(result['pendingStyles'],[True,True]);self.assertEqual(result['calls'],['unlock','retry','reauth','settings']);self.assertFalse(result['menu'])
                finally:context.close()

    def test_cloud_gate_all_ten_views_full_width_with_consistent_headings(self):
        # Real production CSS + compiled gate component in headless Chromium.
        # No account, token, Microsoft network or app startup is involved.
        for mobile, width in ((False, 1100), (True, 390)):
            with self.subTest(mobile=mobile):
                page, context, errors = self.create_page(mobile=mobile, width=width)
                try:
                    result = page.evaluate('''async()=>{
                      const {FINANCE_CLOUD_GATE_PAGES,syncFinanceCloudGates}=await import('/dist/src/ui/cloud-gate.js');
                      const host=document.createElement('div');host.style.cssText='width:100%;max-width:100%;min-width:0';
                      host.id='cloud-e2e-canvas';document.querySelector('.e2e-panel').prepend(host);
                      for(const meta of FINANCE_CLOUD_GATE_PAGES){
                        const view=document.createElement('section');view.id=meta.id;
                        // The assets heading is nested in production. Others differ in lead structure.
                        const legacy=document.createElement('div');legacy.className='legacy-heading';
                        legacy.innerHTML=meta.id==='assets-page'?'<section><header><h1>Old assets heading</h1></header></section>':'<h1>Old page heading</h1>';
                        view.append(legacy);host.append(view);
                      }
                      const calls=[];
                      const gated={blocked:true,locked:false,checking:false,
                        notice:{kind:'network',message:'Microsoftに接続できません。通信状態を確認してください'},
                        onRetry:()=>calls.push('retry'),onReauthenticate:()=>calls.push('reauth'),
                        onUnlock:()=>calls.push('unlock'),onSettings:()=>calls.push('settings')};
                      syncFinanceCloudGates(gated);
                      const metrics=FINANCE_CLOUD_GATE_PAGES.map(meta=>{
                        const view=document.getElementById(meta.id);
                        const gate=view.querySelector(':scope > .finance-cloud-gate');
                        const panel=gate?.querySelector('.finance-cloud-gate-panel');
                        const heading=gate?.querySelector('.finance-cloud-gate-heading');
                        return {id:meta.id,title:heading?.querySelector('h1')?.textContent,
                          subtitle:heading?.querySelector('p.lead')?.textContent,
                          eyebrow:heading?.querySelector('.eyebrow')?.textContent,
                          originalHidden:getComputedStyle(view.querySelector('.legacy-heading')).display==='none',
                          viewWidth:view.getBoundingClientRect().width,
                          panelWidth:panel?.getBoundingClientRect().width,
                          actionCount:panel?.querySelectorAll('button').length,
                          visible:getComputedStyle(gate).display!=='none'};
                      });
                      const first=document.getElementById(FINANCE_CLOUD_GATE_PAGES[0].id);
                      for(const button of first.querySelectorAll('.finance-cloud-gate-panel button'))button.click();
                      syncFinanceCloudGates({...gated,blocked:false});
                      return {metrics,calls,restored:FINANCE_CLOUD_GATE_PAGES.every(meta=>{
                        const view=document.getElementById(meta.id);
                        return !view.classList.contains('finance-cloud-gated')&&
                          !view.querySelector('.finance-cloud-gate')&&
                          getComputedStyle(view.querySelector('.legacy-heading')).display!=='none';
                      })};
                    }''')
                    self.assertEqual(len(result['metrics']), 10)
                    for row in result['metrics']:
                        self.assertTrue(row['title'], row)
                        self.assertTrue(row['subtitle'], row)
                        self.assertTrue(row['eyebrow'], row)
                        self.assertTrue(row['originalHidden'], row)
                        self.assertTrue(row['visible'], row)
                        self.assertEqual(row['actionCount'], 3, row)
                        self.assertGreater(row['panelWidth'], 260, row)
                        self.assertLess(abs(row['panelWidth'] - row['viewWidth']), 2, row)
                    self.assertEqual(result['calls'], ['retry', 'reauth', 'settings'])
                    self.assertTrue(result['restored'])
                    self.assertFalse(errors, errors)
                finally:
                    context.close()


    def test_disconnected_manager_footer_is_not_pinned_and_unlocked_scroll_unchanged(self):
        # Use the actual bundled production CSS in Chromium. No Microsoft login.
        page, context, errors = self.create_page(width=1100)
        try:
            result = page.evaluate('''()=>{
              const shell=document.createElement('div');shell.className='app-shell';
              const workspace=document.createElement('main');workspace.className='workspace';
              const topbar=document.createElement('div');topbar.className='topbar';topbar.textContent='Finance';
              const content=document.createElement('div');content.className='content';
              const manager=document.createElement('section');manager.id='manage-view';
              manager.className='manage-view finance-cloud-gated';
              manager.innerHTML=`
                <div class="finance-cloud-gate">
                  <header class="finance-cloud-gate-heading"><div class="eyebrow">MANAGE</div><h1>明細管理</h1><p class="lead">明細の確認</p></header>
                  <section class="finance-cloud-gate-panel"><h2>OneDriveに接続できません</h2>
                    <p>通信状態を確認してください</p>
                    <div class="finance-cloud-gate-actions"><button>再試行</button><button>設定</button></div>
                  </section>
                </div>
                <div class="manage-grid">
                  <section class="manage-index panel"><div class="statement-list">明細一覧</div></section>
                  <section class="manage-editor panel"><div id="manage-content"><div class="table-scroll">取引一覧</div></div></section>
                </div>`;
              const footer=document.createElement('footer');footer.textContent='FINANCE IMPORTER';
              content.append(manager,footer);workspace.append(topbar,content);shell.append(workspace);
              // Replace the E2E fixture, including its 1200px scroll spacer.
              // Otherwise absolute viewport coordinates measure the spacer too.
              document.body.replaceChildren(shell);
              const gate=manager.querySelector('.finance-cloud-gate');
              const locked={
                footerGap:footer.getBoundingClientRect().top-gate.getBoundingClientRect().bottom,
                flexGrow:getComputedStyle(manager).flexGrow,
                contentOverflowY:getComputedStyle(content).overflowY,
                footerBottom:footer.getBoundingClientRect().bottom
              };
              manager.classList.remove('finance-cloud-gated');gate.remove();
              const unlocked={
                flexGrow:getComputedStyle(manager).flexGrow,
                contentOverflowY:getComputedStyle(content).overflowY,
                listOverflowY:getComputedStyle(manager.querySelector('.statement-list')).overflowY,
                rowsOverflowY:getComputedStyle(manager.querySelector('.table-scroll')).overflowY
              };
              return {locked,unlocked};
            }''')
            self.assertGreaterEqual(result['locked']['footerGap'], 15, result)
            self.assertLess(result['locked']['footerGap'], 100, result)
            self.assertLessEqual(result['locked']['footerBottom'], 850, result)
            self.assertEqual(result['locked']['flexGrow'], '0', result)
            self.assertEqual(result['locked']['contentOverflowY'], 'hidden', result)
            self.assertEqual(result['unlocked']['flexGrow'], '1', result)
            self.assertEqual(result['unlocked']['contentOverflowY'], 'hidden', result)
            self.assertEqual(result['unlocked']['listOverflowY'], 'auto', result)
            self.assertEqual(result['unlocked']['rowsOverflowY'], 'auto', result)
            self.assertFalse(errors, errors)
        finally:
            context.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
