package app.scalvs;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Amplitude: sessions, app open and screen views only (see Analytics.java). Invisible.
        Analytics.start(this);
        Analytics.watch(getBridge());
        // "Sign in with Cumulus ID" and "Create a Cumulus ID" run on id.cumuluscloud.app inside the
        // app (allowNavigation) and come back to SCALVS signed in. Passkeys need WebAuthn in the
        // WebView; it also needs id.cumuluscloud.app/.well-known/assetlinks.json to list app.scalvs.
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(web.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }
    }
}
