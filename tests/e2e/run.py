"""Actual Chromium/Playwright E2E using only fabricated data and localhost.

Does not launch Finance auth, does not access Microsoft Graph, and never writes a vault.
Uses the actual compiled Finance UI modules and production CSS, not source regexes.
"""
import http.server
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit, unquote

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


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


class FinanceBrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
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
    def offline_document():
        import base64, json, re
        html=re.sub(r'<script\b[^>]*>.*?</script>','',(ROOT/'dist/index.html').read_text(encoding='utf-8'),flags=re.S)
        # This is test-only document markup; production CSP is independently audited.
        html=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>','',html)
        html=re.sub(r'<link\b[^>]*>','',html)
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
            modules[module_key(file)]='data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
        html=html.replace('</head>','<script type="importmap">'+json.dumps({'imports':modules})+'</script></head>')
        return html

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
                          const closeIds=['import-add-close','import-revision-close','categories-dialog-close','recent-merchants-close','assets-once-close'];
                          const closes=closeIds.map(id=>{const el=$(id),dialog=el.closest('dialog');dialog.showModal();const r=el.getBoundingClientRect(),c=cs(el);const result={id,w:r.width,h:r.height,font:c.fontSize,visible:r.width>0&&r.right<=document.documentElement.clientWidth+1};dialog.close();return result;});
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
                        self.assertTrue(result['originalHidden']);self.assertFalse(result['duplicateSuccess']);self.assertTrue(result['amountDiff'])
                        self.assertIn('保存操作でOneDriveへ反映',result['revisionText'])
                    self.assertFalse(errors,errors)
                finally:
                    context.close()

    def test_fixed_cost_editor_modes_and_account_reference(self):
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
                        frequency:'monthly',dayOfMonth:31,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:null,enabled:true,
                        amount:1300,pricing:[{effectiveOn:start,amount:1000},{effectiveOn:future,amount:1300}],pauses:[],priceKind:'fixed',note:'元のメモ'},
                        {id:'income-demo',kind:'income',name:'定期入金テスト',fromAccountId:null,toAccountId:'rakuten-bank',frequency:'monthly',dayOfMonth:20,monthOfYear:null,weekday:null,startOn:start,endOn:null,categoryId:null,enabled:true,amount:4000}];
                      const writes=[];window.financePhase2={data,writes,start,future,today:day(now.getFullYear(),now.getMonth()+1,now.getDate())};
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),readonlyRecords:()=>[],
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
                      const source=()=>({assets:vault.assetSettings(),records:[],rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}});
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
                    bank=page.locator('#assets-fixed-cost-list')
                    self.assertIn('1,000円',bank.inner_text())
                    self.assertTrue(bank.locator('.assets-recurring-item').first.evaluate('e=>e.scrollWidth<=e.clientWidth+2'))
                    self.assertEqual(bank.locator('button').count(),0)
                    self.assertEqual(page.locator('.assets-reconcile-shared').count(),1)
                    fields=page.locator('.recurring-account-row').evaluate('e=>({tracks:getComputedStyle(e).gridTemplateColumns.split(" ").length,amount:e.querySelector("#assets-recurring-amount").getBoundingClientRect().width,to:e.querySelector("#assets-recurring-to").getBoundingClientRect().width})')
                    self.assertLessEqual(fields['tracks'],2)
                    self.assertGreater(fields['amount'],0);self.assertAlmostEqual(fields['amount'],fields['to'],delta=3)
                    self.assertEqual(bank.get_by_role('button',name='編集',exact=True).count(),0)
                    self.assertEqual(bank.get_by_role('button',name='削除',exact=True).count(),0)
                    page.locator('#assets-fixed-cost-open').click()
                    page.locator('.fixed-cost-item').filter(has_text='銀行固定費テスト').get_by_role('button',name='詳細・編集').click()
                    detail=page.locator('.fixed-cost-dialog')
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
                        for row in [('amount','method','cardId'),('merchant','category'),('frequency','startOn','day')]:
                            self.assertLessEqual(max(a[n]['y'] for n in row)-min(a[n]['y'] for n in row),2)
                            self.assertEqual(sorted(row,key=lambda n:a[n]['x']),list(row))
                        self.assertAlmostEqual(p['w'],a['merchant']['w'],delta=2)
                        self.assertGreater(p['x'],a['merchant']['x']);self.assertLess(p['x'],a['category']['x'])
                    else:
                        self.assertLess(geometry['a']['amount']['y'],geometry['a']['method']['y'])
                    self.assertTrue(form.get_by_role('radio',name='固定額',exact=True).is_checked())
                    self.assertTrue(form.locator('.fixed-cost-price-choice').evaluate_all("xs=>xs.every(x=>getComputedStyle(x).justifyContent==='flex-start')"))
                    form.get_by_role('radio',name='変動額',exact=True).check();self.assertEqual(form.locator('[name="priceKind"]').input_value(),'variable')
                    self.assertNotIn('priceDate',visible());self.assertNotIn('statusDate',visible());self.assertNotIn('status',visible())
                    form.locator('[name="method"]').select_option('cash')
                    self.assertNotIn('cardId',visible());self.assertNotIn('accountId',visible())
                    form.locator('[name="method"]').select_option('bank')
                    self.assertIn('accountId',visible());self.assertNotIn('cardId',visible())
                    form.locator('[name="method"]').select_option('card')
                    self.assertIn('cardId',visible());self.assertNotIn('accountId',visible())
                    form.locator('[name="name"]').fill('年払いテスト')
                    form.locator('[name="amount"]').fill('21300');form.locator('[name="frequency"]').select_option('yearly')
                    self.assertIn('month',visible());self.assertIn('1,775円',form.inner_text())
                    self.assertTrue(form.evaluate('e=>e.scrollWidth<=e.clientWidth+2'))
                    form.locator('[name="startOn"]').fill(page.evaluate('window.financePhase2.future'))
                    form.get_by_role('button',name='保存',exact=True).click()
                    page.wait_for_function('window.financePhase2.writes.length===4')
                    new=page.evaluate('window.financePhase2.writes[3].entry')
                    self.assertEqual(new['pricing'],[{'effectiveOn':new['startOn'],'amount':21300}])
                    self.assertEqual(new['priceKind'],'variable');self.assertEqual(new['pauses'],[]);self.assertIsNone(new['endOn'])
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
                    self.assertEqual(changed['id'],'bank-cost-demo');self.assertEqual(changed['fromAccountId'],'rakuten-bank')
                    self.assertEqual([x['payment'] for x in changed['paymentHistory']],['bank','card']);self.assertEqual(changed['pricing'][-1]['amount'],1500);self.assertEqual(changed['note'],'同時変更')
                    page.evaluate('window.financePhase2.refreshAssets()')
                    self.assertNotIn('銀行固定費テスト',bank.text_content())
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
                    page.evaluate('window.financePhase2.lock()');self.assertEqual(page.locator('#assets-recurring-list').text_content(),'');self.assertEqual(page.locator('#assets-fixed-cost-list').text_content(),'')
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
                      const records=[bill];const vault={unlocked:true,assetSettings:()=>structuredClone(data),readonlyRecords:()=>structuredClone(records),
                        async deleteRecurring(id){writes.push(['recurring',id]);data.recurring=data.recurring.filter(x=>x.id!==id);},
                        async deleteBalanceSnapshot(id){writes.push(['balance',id]);data.snapshots=data.snapshots.filter(x=>x.id!==id);}};
                      const source=()=>vault.unlocked?{assets:vault.assetSettings(),records:vault.readonlyRecords(),rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}}:null;
                      const assets=initAssetsSettings(()=>vault,()=>[],()=>{});
                      const home=initHome({source,navigate(){},async saveMizuhoFunding(m,done,snapshot){writes.push(['funding',m,done]);data.mizuhoFundingChecks={...data.mizuhoFundingChecks,[m]:{done,updatedAt:new Date().toISOString(),...snapshot}};}});
                      const summary=initMonthlySummary({source,openRecord(){},openDrilldown(){},async saveCardNoUseMonth(m,yes){writes.push(['no-use',m,yes]);const months=new Set(data.cardNoUseMonths??[]);if(yes)months.add(m);else months.delete(m);data.cardNoUseMonths=[...months];}});
                      const show=id=>{for(const node of document.querySelectorAll('.workspace .content>section'))node.classList.toggle('hidden',node.id!==id);document.getElementById(id).classList.remove('hidden');};
                      window.ordinary={data,writes,bill,records,current,previous,assets,home,summary,showAssets(){show('assets-page');assets.render();},showHome(){show('home-view');home.render();},showSummary(){show('summary-view');summary.setPeriod(current);}};
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
                    self.assertEqual(funding.inner_text(),'送金済みを記録')
                    page.evaluate("window.ordinary.bill.statement.confirmation='provisional';window.ordinary.home.render()")
                    self.assertIn('明細未確定',page.locator('.home-funding-prior').inner_text())
                    self.assertTrue(page.locator('.home-funding-prior .home-funding-review').is_visible())
                    self.assertEqual(page.locator('.home-funding-prior .home-funding-save').count(),0)
                    page.evaluate("window.ordinary.bill.statement.confirmation='confirmed';window.ordinary.home.render()")
                    funding.click();page.evaluate('window.ordinary.bill.statement.rows[0].amount=2000;window.ordinary.bill.statement.statedTotal=2000')
                    confirm.get_by_role('button',name='送金済みを記録').click();self.assertEqual(page.evaluate('window.ordinary.writes.length'),2)
                    funding.click();confirm.get_by_role('button',name='送金済みを記録').click()
                    page.wait_for_function('window.ordinary.writes.length===3')
                    self.assertEqual(page.evaluate('window.ordinary.writes.at(-1)'),['funding',page.evaluate('window.ordinary.previous'),True])
                    # No-use approval belongs to the originally displayed month, never another month.
                    page.evaluate('window.ordinary.showSummary()');noUse=page.get_by_role('button',name='この月はカード利用なしと確認')
                    noUse.click();page.evaluate('window.ordinary.summary.setPeriod(window.ordinary.previous)')
                    confirm.get_by_role('button',name='確認を記録').click();self.assertEqual(page.evaluate('window.ordinary.writes.length'),3)
                    page.evaluate('window.ordinary.showSummary()');noUse.click();page.evaluate('window.ordinary.summary.reset()')
                    confirm.wait_for(state='detached');self.assertEqual(page.evaluate('window.ordinary.writes.length'),3)
                    page.evaluate('window.ordinary.showSummary()');noUse.click();confirm.get_by_role('button',name='確認を記録').click()
                    page.wait_for_function('window.ordinary.writes.length===4')
                    page.get_by_role('button',name='「カード利用なし」を取り消す').click();confirm.get_by_role('button',name='取り消す').click()
                    page.wait_for_function('window.ordinary.writes.length===5')
                    self.assertEqual(page.evaluate('window.ordinary.writes.slice(-2)'),[['no-use',page.evaluate('window.ordinary.current'),True],['no-use',page.evaluate('window.ordinary.current'),False]])
                    self.assertEqual(errors,[])
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
                      const {formatYen:yen}=await import('finance-fixture/ui/formatters.js');
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
                      const test=window.securityTest={epoch:0,deletes:[],rotations:0,cancel:()=>modal.cancelAllConfirmations()};
                      try{settings.initCloudSettings({hasUnsavedChanges:()=>false,confirmationContext:()=>{const epoch=test.epoch;return ()=>epoch===test.epoch;},
                        onRefresh:async()=>{},onMigration:async()=>{},onLock:async()=>true,
                        onCleanupPreview:async()=>({generationCount:2,legacyFolderCount:0,unreferencedOriginalCount:1,legacyV1Count:0,snapshots:[]}),
                        onCleanupDelete:async which=>{test.deletes.push(which);return 2;},onChangePassphrase:async()=>{test.rotations++;}});}finally{window.URL=NativeURL;}
                      for(const view of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"]'))view.classList.toggle('hidden',view.id!=='settings-view');
                      for(const el of document.querySelectorAll('#settings-view details'))el.open=true;
                    }''')
                    dialog=page.locator('.finance-confirm-dialog')
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
                    page.locator('#nav-payroll').scroll_into_view_if_needed()
                    self.assertTrue(page.locator('#nav-payroll').evaluate('e=>{const r=e.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0}'))
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
                      const vault={unlocked:true,listArchivedMonths:async()=>archive?[current]:[],loadArchivedReport:async()=>archive,
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
                    self.assertEqual(summary.locator('.points-benefits-heading strong').inner_text(),'—')
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
                    page=context.new_page();errors=[]
                    page.on('pageerror',lambda exc:errors.append(str(exc)))
                    page.route('**/*',lambda route:route.abort());page.set_content(html)
                    page.evaluate('''async()=>{
                      const {emptyAssets}=await import('finance-fixture/cloud/assets.js');
                      const {initSubscriptions}=await import('finance-fixture/ui/subscriptions.js');
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
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),readonlyRecords:()=>[]};
                      const source=()=>vault.unlocked?{assets:vault.assetSettings(),records:[],rules:[],categories:[],payroll:{ready:false,entries:[],syncedAt:null}}:null;
                      const show=id=>{for(const node of document.querySelectorAll('.workspace .content > :is(section,div)[id$="-view"],#assets-page'))node.classList.toggle('hidden',node.id!==id);document.getElementById(id).classList.remove('hidden');};
                      const subs=initSubscriptions({source,vault:()=>vault,onSaved:()=>{},openAccountSettings:()=>{}});
                      const accounts=initAssetsSettings(()=>vault,()=>[],()=>{},()=>{});
                      const forecast=initFutureProjection(source);const cards=initCardSettings(()=>vault,()=>{});
                      window.polish3={show,subs,accounts,forecast,cards,lock(){vault.unlocked=false;accounts.reset();forecast.reset();cards.reset();subs.reset();}};
                      show('subscriptions-view');subs.render();
                    }''')
                    normal=page.locator('.fixed-cost-item').filter(has_text='通常契約')
                    self.assertNotIn('変更予定：',normal.inner_text())
                    geometry=normal.evaluate('e=>{const a=e.querySelector(".fixed-cost-item-actions").getBoundingClientRect(),p=e.querySelector(".fixed-cost-item-price").getBoundingClientRect();return {align:Math.abs(a.right-p.right),above:a.top<p.top}}')
                    self.assertLessEqual(geometry['align'],2);self.assertTrue(geometry['above'])
                    normal.get_by_role('button',name='詳細・編集').click()
                    detail=page.locator('.fixed-cost-dialog[open]');self.assertNotIn('支払条件の変更履歴',detail.inner_text());self.assertNotIn('料金変更履歴',detail.inner_text())
                    detail.get_by_role('button',name='閉じる').click()
                    future=page.locator('.fixed-cost-item').filter(has_text='将来契約')
                    self.assertIn('変更予定：3,000円',future.inner_text())
                    page.get_by_role('button',name='対象外 1').click();ignored=page.locator('.fixed-cost-item').filter(has_text='対象外テスト');self.assertIn('テストカード',ignored.inner_text());self.assertNotIn('rakuten-mizuho',ignored.inner_text())
                    page.evaluate("polish3.show('assets-page');polish3.accounts.render()")
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
                      const vault={unlocked:true,assetSettings:()=>structuredClone(data),async editContract(expected,edit){
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
                      const writes=[];const vault={unlocked:true,assetSettings:()=>structuredClone(data),async setCardConfiguration(prefs,debits){data.cardPreferences=validateCardPreferences(prefs);data.cardDebitAccounts=debits;writes.push(structuredClone(data.cardPreferences));}};
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
                    self.assertIn('210,000円',metric.inner_text())
                    self.assertIn('入金予定含む',metric.inner_text())
                    self.assertIn('定期入金 20,000円',metric.inner_text())
                    self.assertIn('副業給与',page.locator('#monthly-content').inner_text())
                    page.evaluate('window.addActualSide()')
                    self.assertIn('213,000円',metric.inner_text())
                    self.assertNotIn('入金予定含む',metric.inner_text())
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
