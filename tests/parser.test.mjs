import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatementText } from '../dist/src/importers/statement-parser.js';
import { planStatementImport, statementSignature } from '../dist/src/importers/import-policy.js';

const run = text => parseStatementText(text, 'paste', '架空のテスト明細');
const total = statement => statement.rows.reduce((sum, row) => sum + row.amount, 0);

test('SMBC: Amazon purchases do not identify the Vpass card', () => {
  const statement = run(`三井住友カード\n# 2026年12月28日お支払い分のご利用明細\n2026年11月14日現在判明分\n2026年12月 支払い予定分のご利用明細合計\n**643円**\n| ご利用日 | ご利用店名 | カード | 支払区分 | 分割回数 | 支払予定月 | ご利用金額 |\n| 26/11/10 | ＡＭＡＺＯＮ．ＣＯ．ＪＰ | ご本人 | 1回払い | | 26/12 | 258 |\n| 26/11/02 | ＡＭＡＺＯＮ．ＣＯ．ＪＰ | ご本人 | 1回払い | | 26/12 | 385 |`);
  assert.equal(statement.provider, 'smbc'); assert.equal(statement.cardId, null);
  assert.equal(statement.paymentDate, '2026-12-28'); assert.equal(statement.billingMonth, '2026-12');
  assert.equal(statement.confirmation, 'provisional'); assert.equal(statement.statedTotal, 643);
  assert.equal(statement.rows.length, 2); assert.equal(total(statement), 643);
});

test('GOLD POINT: shifted Markdown row and final amount', () => {
  const statement = run(`GOLD POINT CARD +\n# 2026年10月27日のお支払い明細印刷する\n| お支払い合計額 | 213,950円 |\n| ご利用日 | ご利用店名 | ご利用金額 | 支払区分 |\n|  | 26/09/05 | テスト家電店 | 213,950 | １ | １ | 213,950 |`);
  assert.equal(statement.provider, 'goldpoint'); assert.equal(statement.cardId, 'goldpoint');
  assert.equal(statement.paymentDate, '2026-10-27'); assert.equal(statement.statedTotal, 213950);
  assert.equal(statement.rows.length, 1); assert.equal(statement.rows[0].merchant, 'テスト家電店');
  assert.equal(total(statement), 213950);
});

test('Rakuten: header is split over two lines, ETC memo belongs to preceding row', () => {
  const statement = run(`楽天カード株式会社\n2026年11月ご請求金額 ご利用カード\n2,940円 楽天カード（Visa） ****-****-****-4354\nお支払日 返済方法 引落口座\n2026/11/27 口座振替\n利用日 利用店名 利用者 支払方法 利用金額 手数料/利息 支払総額 当月支払額 当月請求額 翌月繰越残高\n2026/10/03 ETCカード売上 ETC* 1回払い 320 0 320 320 320 0\nトンネルA 出口B\n2026/10/03 ETCカード売上 ETC* 1回払い 670 0 670 670 670 0\n区間C 出口D\n2026/09/26 ETCカード売上 ETC* 1回払い 1,950 0 1,950 1,950 1,950 0\n※お支払金額確定前の明細になります。`);
  assert.equal(statement.cardId, null); assert.equal(statement.billingMonth, '2026-11');
  assert.equal(statement.statedTotal, 2940); assert.equal(statement.rows.length, 3);
  assert.equal(total(statement), 2940);
  assert.match(statement.rows[0].description, /トンネルA/);
});

test('JCB: only actual charged rows, not repeated totals', () => {
  const statement = run(`株式会社ジェーシービー リクルートカード\n今回のお支払日 2026年11月10日(火)\n2026/09/18 テスト商店 980 1回 980 Google Payご利用分\n2026/10/08 別の店舗 3,690 1回 3,690\n◆お支払小計 4,670\n◆今回のお支払金額総合計 4,670`);
  assert.equal(statement.cardId, 'recruit-jcb'); assert.equal(statement.rows.length, 2);
  assert.equal(statement.billingMonth, '2026-11'); assert.equal(total(statement), 4670);
  assert.equal(statement.statedTotal, 4670);
});

test('View: two-digit split date and payment amount', () => {
  const statement = run(`ビックカメラSuicaカードご利用代金明細書\nお支払額 1,950円 お支払日 2026年11月04日\n26 09 27 ★ APPLE COM BILL 1,600 1,600 1回払 1,600\n26 10 03 ★ APPLE COM BILL 300 300 1回払 300\n26 10 05 ★ APPLE COM BILL 50 50 1回払 50\nご請求額合計 1,950`);
  assert.equal(statement.cardId, 'bic-suica'); assert.equal(statement.rows.length, 3);
  assert.equal(statement.statedTotal, 1950); assert.equal(total(statement), 1950);
});

test('Unknown template must not silently pretend to be valid', () => {
  const statement = run('just some text');
  assert.equal(statement.provider, 'unknown'); assert.equal(statement.statedTotal, null);
  assert.equal(statement.rows.length, 0); assert.ok(statement.warnings.length > 0);
});


test('SMBC: merchant names without Amazon do not identify NL either', () => {
  const statement = run(`三井住友カード
# 2026年12月28日お支払い分のご利用明細
2026年11月14日現在判明分
2026年12月 支払い予定分のご利用明細合計
**638円**
| ご利用日 | ご利用店名 | カード | 支払区分 | 分割回数 | 支払予定月 | ご利用金額 |
| 26/11/06 | マクドナルド | ご本人 | 1回払い | | 26/12 | 500 |
| 26/11/04 | ローソン | ご本人 | 1回払い | | 26/12 | 138 |`);
  assert.equal(statement.cardId, null);
  assert.equal(statement.rows.length, 2);
  assert.equal(total(statement), 638);
});

test('Import policy: identical parsed statements are not added twice', () => {
  const raw = `三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | テスト店 | ご本人 | 1回払い | | 26/12 | 100 |`;
  const a = run(raw);
  const b = run(raw);
  assert.deepEqual(planStatementImport([a], b), { kind: 'add' });
  a.cardId=b.cardId='smbc-nl';
  assert.deepEqual(planStatementImport([a], b), { kind: 'duplicate', index: 0 });
  assert.equal(statementSignature(a), statementSignature(b));
});

test('Import policy: a changed amount for the same card/month is a revision', () => {
  const a = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | テスト店 | ご本人 | 1回払い | | 26/12 | 100 |`);
  const b = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**200円**
| 26/11/10 | テスト店 | ご本人 | 1回払い | | 26/12 | 200 |`);
  // Revisions can only be resolved after the user has selected the card.
  a.cardId = 'smbc-nl';
  b.cardId = 'smbc-nl';
  assert.deepEqual(planStatementImport([a], b), { kind: 'revision', index: 0 });
});

test('Import policy: different cards with the same month are not combined', () => {
  const amazon = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | AMAZON.CO.JP | ご本人 | 1回払い | | 26/12 | 100 |`);
  const nl = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | ローソン | ご本人 | 1回払い | | 26/12 | 100 |`);
  // Both cards were explicitly selected after the ambiguous Vpass parse.
  nl.cardId = 'smbc-nl';
  amazon.cardId = 'amazon';
  assert.deepEqual(planStatementImport([nl], amazon), { kind: 'add' });
});

test('Import policy: manual row changes do not break frozen source signatures', () => {
  const a = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | テスト店 | ご本人 | 1回払い | | 26/12 | 100 |`);
  a.cardId='smbc-nl';
  const frozen = statementSignature(a);
  a.rows[0].merchant = '手動で変更';
  const b = run(`三井住友カード
2026年12月28日お支払い分のご利用明細
2026年12月 支払い予定分のご利用明細合計
**100円**
| 26/11/10 | テスト店 | ご本人 | 1回払い | | 26/12 | 100 |`);
  b.cardId='smbc-nl';
  assert.deepEqual(planStatementImport([a], b, () => frozen), { kind: 'duplicate', index: 0 });
});
