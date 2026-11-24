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
