/** Official MSAL v5 redirect bridge. This page must never initialize Finance. */
void globalThis.msalRedirectBridge.broadcastResponseToMainFrame().catch(() => {
  document.body.textContent='Microsoft認証の完了を確認できませんでした。Financeに戻って再接続してください。';
});
