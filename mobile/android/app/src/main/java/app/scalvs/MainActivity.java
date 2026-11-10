package app.scalvs;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        injectAdsConfig();
    }

    @Override
    public void onStart() {
        super.onStart();
        injectAdsConfig();
    }

    /**
     * Pushes Gradle BuildConfig (ADS_ENABLED, debug vs release banner id) into
     * the WebView so ads.js can use test units in debug and the real unit in
     * release. Ads stay off until ADS_ENABLED is flipped to true.
     */
    private void injectAdsConfig() {
        if (getBridge() == null) return;
        WebView web = getBridge().getWebView();
        if (web == null) return;
        String banner = BuildConfig.ADMOB_BANNER_ID.replace("\\", "\\\\").replace("'", "\\'");
        String js = "window.SCALVS_ADS_DEBUG=" + (BuildConfig.DEBUG ? "true" : "false")
            + ";window.SCALVS_ADS_ENABLED=" + (BuildConfig.ADS_ENABLED ? "true" : "false")
            + ";window.SCALVS_ADMOB_BANNER_ID='" + banner + "';"
            + "window.startScalvsAds&&window.startScalvsAds();";
        web.evaluateJavascript(js, null);
    }
}
