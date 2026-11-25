# Preserve JavascriptInterface methods used for PDF/Excel/Backup Blob downloads
-keepclassmembers class in.ledgerflow.app.MainActivity$BlobDownloadBridge {
    @android.webkit.JavascriptInterface <methods>;
}
