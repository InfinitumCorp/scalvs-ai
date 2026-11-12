package app.scalvs;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebView;
import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Collections;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;

/**
 * Privacy-first Amplitude (official Android SDK). Tracks sessions, app open/close and the
 * SCALVS screen being viewed in the WebView. Nothing else: no element or form capture, no
 * session replay, no remote config, no diagnostics, no IP, city, DMA, lat/lng or advertising
 * id, and never a user id. Public API key only; the Amplitude secret key never ships in apps.
 */
final class Analytics {
    private static final String PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";
    private static Amplitude amplitude;
    private static String lastScreen;

    private Analytics() {}

    static synchronized void start(Context context) {
        if (amplitude != null) return;
        Configuration config = new Configuration(PUBLIC_API_KEY, context.getApplicationContext());
        config.setServerZone(ServerZone.US);
        config.setAutocapture(EnumSet.of(AutocaptureOption.SESSIONS, AutocaptureOption.APP_LIFECYCLES));
        config.setEnableAutocaptureRemoteConfig(false);
        config.setEnableDiagnostics(false);
        config.setUseAdvertisingIdForDeviceId(false);
        config.setUseAppSetIdForDeviceId(false);
        config.setLocationListening(false);
        config.setTrackingOptions(new TrackingOptions()
            .disableCity().disableDma().disableLatLng().disableIpAddress().disableAdid().disableAppSetId());
        amplitude = new Amplitude(config);
    }

    /** Wraps Capacitor's WebViewClient so every page or in-app route change counts as a screen view. */
    static void watch(Bridge bridge) {
        if (bridge == null || bridge.getWebView() == null) return;
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                screen(url);
            }
        });
    }

    private static synchronized void screen(String url) {
        if (amplitude == null || url == null) return;
        String name = screenName(url);
        if (name == null || name.equals(lastScreen)) return;
        lastScreen = name;
        Map<String, Object> props = new HashMap<>();
        props.put("[Amplitude] Screen Name", name);
        amplitude.track("[Amplitude] Screen Viewed", Collections.unmodifiableMap(props));
    }

    /**
     * The screen name is the path plus the in-app route (#/command), without any query string or
     * other fragment, so sign-in codes, tokens and search text never leave the phone.
     */
    static String screenName(String url) {
        Uri uri;
        try { uri = Uri.parse(url); } catch (RuntimeException e) { return null; }
        String host = uri.getHost();
        if (host == null) return null;
        String path = uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath();
        if ("localhost".equals(host)) return "app" + path;
        String route = "";
        String fragment = uri.getFragment();
        if (fragment != null && fragment.startsWith("/")) {
            int cut = fragment.indexOf('?');
            route = "#" + (cut >= 0 ? fragment.substring(0, cut) : fragment);
        }
        boolean scalvs = host.equals("scalvs.app") || host.endsWith(".scalvs.app") || host.endsWith(".run.app");
        return (scalvs ? "" : host) + path + route;
    }
}
