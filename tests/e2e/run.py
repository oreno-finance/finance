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


if __name__ == '__main__':
    unittest.main(verbosity=2)
