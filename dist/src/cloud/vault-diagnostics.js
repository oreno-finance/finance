import { parseIndexEnvelope, parseEnvelope, deriveCloudKey, decryptIndex, decryptDocument, decryptRules, decryptAssets, decryptMonthlyReport } from './cloud-crypto.js';
function details(error) {
    // Do not copy raw exception text: Graph URLs, response bodies and file IDs are private.
    if (error instanceof SyntaxError)
        return 'JSON構文エラー';
    if (error instanceof TypeError)
        return '通信または形式エラー';
    if (error instanceof Error && /復号|パスフレーズ|破損|整合性/.test(error.message))
        return '復号・整合性エラー';
    if (error instanceof Error && /JSON|形式|ソルト|暗号|サイズ|上限/.test(error.message))
        return '暗号ファイルの形式エラー';
    return '読取エラー（通信・認証・アクセス権など）';
}
function basicEnvelope(text, format, salt) {
    if (text.length > 2_000_000)
        throw new Error('サイズ上限');
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object')
        throw new Error('形式不正');
    const v = obj;
    if (v.format !== format || v.salt !== salt || v.iterations !== 310000 ||
        typeof v.iv !== 'string' || typeof v.data !== 'string' ||
        v.iv.length !== 16 || !/^[a-zA-Z0-9+/]{16}$/.test(v.iv) ||
        v.data.length < 24 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(v.data))
        throw new Error('形式不正');
}
/** Read-only; optionally decrypts locally using an ephemeral key, never mutates remote data. */
export async function diagnoseVaultFiles(client, passphrase = '', onProgress) {
    const lines = ['Finance / OneDrive 読み取り専用診断 v2', passphrase ? '検査：暗号ファイルの外側JSON・復号整合性（内容は表示しません）' : '検査：暗号ファイルの外側JSON・参照先（内容の復号はしません）'];
    let failures = 0;
    let index;
    onProgress?.('暗号化索引を検査中…');
    try {
        const file = await client.readFinanceIndex();
        if (!file) {
            lines.push('索引：見つかりません');
            return { ok: false, report: lines.join('\n') };
        }
        index = parseIndexEnvelope(file.text);
        lines.push('索引：正常（外側JSON）');
    }
    catch (error) {
        lines.push(`索引：失敗［${details(error)}］`);
        return { ok: false, report: lines.join('\n') };
    }
    try {
        client.setVaultDataSet(index.dataSetId ?? null);
    }
    catch {
        lines.push('世代の参照設定：失敗');
        return { ok: false, report: lines.join('\n') };
    }
    lines.push(`暗号化世代：${index.dataSetId ? '変更後の世代' : '従来形式'}`);
    let decryptKey = null;
    let indexedYears = null;
    let indexDecryptionFailed = false;
    let independentChecks = 0;
    let independentSuccesses = 0;
    if (passphrase) {
        onProgress?.('入力されたパスフレーズで索引を検証中…');
        try {
            decryptKey = await deriveCloudKey(passphrase, index.salt);
            indexedYears = (await decryptIndex(index, decryptKey)).years;
            lines.push('索引の復号：正常');
        }
        catch {
            failures++;
            indexDecryptionFailed = true;
            lines.push('索引の復号：失敗［鍵の不一致・索引の破損など］');
            lines.push('追加検査：索引から独立して、各暗号ファイルの復号を確認します。');
            // Keep investigating. A password that decrypts an independently staged
            // file but not index.enc proves the index needs separate investigation.
        }
    }
    let years;
    onProgress?.('年別明細の一覧を検査中…');
    try {
        years = await client.listYearFiles();
        lines.push(`年別明細の一覧：正常（${years.length}ファイル）`);
        if (indexedYears && (indexedYears.length !== years.length || indexedYears.some(year => !years.some(file => file.year === year)))) {
            failures++;
            lines.push('索引と年別明細の一覧：不一致');
        }
    }
    catch (error) {
        lines.push(`年別明細の一覧：失敗［${details(error)}］`);
        return { ok: false, report: lines.join('\n') };
    }
    for (const item of years) {
        onProgress?.(`年別明細の暗号形式を検査中…（${item.year}）`);
        try {
            const file = await client.readYearVault(item.year);
            if (!file)
                throw new Error('形式不正');
            const envelope = parseEnvelope(file.text);
            if (!indexDecryptionFailed && envelope.salt !== index.salt)
                throw new Error('ソルト不一致');
            if (decryptKey) {
                if (indexDecryptionFailed)
                    independentChecks++;
                // The index's salt may itself be damaged. Verify each file using
                // the salt authenticated by its own AES-GCM ciphertext, not the index.
                const key = indexDecryptionFailed ? await deriveCloudKey(passphrase, envelope.salt) : decryptKey;
                await decryptDocument(envelope, key);
                if (indexDecryptionFailed) {
                    independentSuccesses++;
                    lines.push(`${item.year}年の明細：復号成功（索引と独立して検査）${envelope.salt === index.salt ? '' : '／索引とソルト不一致'}`);
                }
                else
                    lines.push(`${item.year}年の明細：正常（復号・整合性）`);
            }
            else
                lines.push(`${item.year}年の明細：正常（外側JSON）`);
        }
        catch (error) {
            failures++;
            lines.push(`${item.year}年の明細：失敗［${details(error)}］`);
        }
    }
    for (const [label, method, format] of [
        ['利用先ルール', () => client.readMerchantRules(), 'finance-cloud-rules-envelope-v1'],
        ['資産設定', () => client.readAssetSettings(), 'finance-cloud-assets-envelope-v1'],
    ]) {
        onProgress?.(`${label}を検査中…`);
        try {
            const file = await method();
            if (!file) {
                lines.push(`${label}：ファイルなし（初回利用か消失かは判定できません）`);
                continue;
            }
            // If the index failed, read each file's own salt; this avoids treating
            // an index-only salt error as a universal password mismatch.
            const fileSalt = indexDecryptionFailed
                ? JSON.parse(file.text).salt
                : index.salt;
            if (typeof fileSalt !== 'string')
                throw new Error('暗号形式が不正です。');
            basicEnvelope(file.text, format, fileSalt);
            if (decryptKey) {
                if (indexDecryptionFailed)
                    independentChecks++;
                const key = indexDecryptionFailed ? await deriveCloudKey(passphrase, fileSalt) : decryptKey;
                if (label === '利用先ルール')
                    await decryptRules(file.text, key, fileSalt);
                else
                    await decryptAssets(file.text, key, fileSalt);
                if (indexDecryptionFailed) {
                    independentSuccesses++;
                    lines.push(`${label}：復号成功（索引と独立して検査）${fileSalt === index.salt ? '' : '／索引とソルト不一致'}`);
                }
                else
                    lines.push(`${label}：正常（復号・整合性）`);
            }
            else
                lines.push(`${label}：正常（外側JSON）`);
        }
        catch (error) {
            failures++;
            lines.push(`${label}：失敗［${details(error)}］`);
        }
    }
    // The report archive is independent of the statement index and is optional on older installs.
    if (typeof client.listMonthlyReports === 'function') {
        let refs;
        try {
            refs = await client.listMonthlyReports();
            lines.push(`月次レポート：${refs.length}件`);
        }
        catch (error) {
            lines.push(`月次レポート一覧：失敗［${details(error)}］`);
            return { ok: false, report: lines.join('\n') };
        }
        for (const ref of refs) {
            onProgress?.(`${ref.period}のレポートを検査中…`);
            try {
                const file = await client.readMonthlyReport(ref.period);
                if (!file || file.etag !== ref.etag)
                    throw new Error('更新情報が一致しません。');
                const fileSalt = indexDecryptionFailed ? JSON.parse(file.text).salt : index.salt;
                if (typeof fileSalt !== 'string')
                    throw new Error('暗号形式が不正です。');
                basicEnvelope(file.text, 'finance-monthly-report-envelope-v1', fileSalt);
                if (decryptKey) {
                    if (indexDecryptionFailed)
                        independentChecks++;
                    const key = indexDecryptionFailed ? await deriveCloudKey(passphrase, fileSalt) : decryptKey;
                    await decryptMonthlyReport(file.text, key, fileSalt, ref.period);
                    if (indexDecryptionFailed)
                        independentSuccesses++;
                }
                lines.push(`${ref.period}：正常（${decryptKey ? '復号・整合性' : '暗号形式'}）`);
            }
            catch (error) {
                failures++;
                lines.push(`${ref.period}：失敗［${details(error)}］`);
            }
        }
    }
    if (indexDecryptionFailed) {
        lines.push(`索引以外の独立復号：${independentSuccesses}/${independentChecks}件成功`);
        if (independentSuccesses > 0) {
            lines.push('判定：このパスフレーズで復号できる暗号ファイルがあります。索引だけの不整合を重点調査してください。');
        }
        else if (independentChecks > 0) {
            lines.push('判定：索引以外も復号できません。入力文字列の相違か暗号データ異常かは未確定です。');
        }
        else {
            lines.push('判定：独立した検査対象がありません。入力文字列と索引のどちらに問題があるか未確定です。');
        }
    }
    lines.push(`診断結果：${failures ? `${failures}項目で異常` : decryptKey ? '索引・明細・設定の復号検査で異常は見つかりませんでした' : '外側JSONに異常は見つかりませんでした'}`);
    lines.push(passphrase ? '注意：PDF原本、口座の実残高、全実データの完全性までは検査していません。' : '注意：復号後のJSON、鍵の一致、PDF原本、実データの完全性までは検査していません。');
    lines.push('この診断は読み取り専用であり、OneDrive上のファイルを変更していません。');
    return { ok: failures === 0, report: lines.join('\n') };
}
