# Finance: Microsoftアカウント認証の設定（MSAL v5）

## デプロイ前に必要なMicrosoft Entra設定

Financeの「設定 → OneDrive → リダイレクトURI（SPA）」に表示される **新しいURI** を、Microsoft Entra の対象アプリ登録で「認証 > プラットフォーム構成 > シングルページ アプリケーション（SPA）」のリダイレクトURIに登録する。

GitHub Pagesを `https://oreno-finance.github.io/finance/` で利用する場合の例：

`https://oreno-finance.github.io/finance/auth-bridge.html`

**実際の画面に表示されるURIを優先**すること。カスタムドメインや開発環境ではパスが変わる。

1. `npm run build` で `dist/auth-bridge.html` と `dist/vendor/msal/msal-redirect-bridge.min.js` が生成されることを確認。
2. EntraのSPAリダイレクトURIに上記のブリッジURLを追加して保存。従来のアプリ本体URLは検証完了まで維持してよい。
3. GitHub Pagesへデプロイし、`auth-bridge.html` とブリッジJSが200で取得できることを確認。
4. Financeから **Microsoftアカウントで接続** を明示的に操作し、ログイン後にFinance本体へ戻り保管庫を読めることを確認。
5. 通常再接続、明示的な別アカウントへの切替、サインアウト、接続が切れた状態からの復旧を確認。

ブリッジはMSAL公式パッケージに同梱されている `@azure/msal-browser/redirect-bridge` の配布物を使い、Finance本体の処理を一切起動しない。ブリッジページに `Cross-Origin-Opener-Policy` ヘッダーを付与しない。

## 認証の期待動作と制約

- 初回ログイン後は、MSALの`localStorage`キャッシュが別タブでも共有される。
- MSAL v5のキャッシュはセッションCookieに依存する場合があり、ブラウザを完全終了するとMicrosoft認証が必要になることがある。「サインインしたままにする」を選べる場合はその設定に依存する。
- 有効なトークンがあればMSALが使い、必要なら更新トークンなどからサイレント更新する。
- 更新トークンの期限切れや追加認証要件、サードパーティCookie制限によるサイレント認証失敗は、Microsoftの通常の対話型ログインへ案内する。
- Finance保管庫の非抽出鍵の永続記憶はMicrosoft認証とは別。Microsoft認証失敗で保存鍵を削除しない。
- 本改修では `Files.ReadWrite.AppFolder` 以外の権限を付与せず、トークンを独自保存しない。

## Mac / Galaxy手動試験

初回ログイン、ページ再読み込み、別タブでの接続、ブラウザ完全終了・再起動、長時間放置後のデータ取得を確認する。

ネットワークを切った場合、OneDrive一時障害の場合には勝手にログイン画面へ遷移しないこと。接続を戻すと通常の再取得で復旧できること。

2つのMicrosoftアカウントがキャッシュにある場合は、現在選択されたアカウントが優先され、曖昧な場合は接続先を勝手に決めないこと。「別のアカウントに切り替える」から明示的に選択できること。切替前の金融データがロックされること。

「このブラウザを記憶する」が登録済みならMicrosoft認証が成功した後でのみ自動復号を試みる。手動ロック後に勝手に復号しないこと。

## 注意

**新しいSPAリダイレクトURIをEntraに登録する前にこの変更を公開すると、Microsoftログインが失敗する可能性がある。** Entra設定とGitHub Pagesの公開準備を揃えてから切り替えること。
