package app.scalvs;

import android.content.Context;
import com.amplitude.android.Amplitude;
import com.amplitude.android.AutocaptureOption;
import com.amplitude.android.Configuration;
import com.amplitude.android.TrackingOptions;
import com.amplitude.core.ServerZone;
import java.util.EnumSet;

/**
 * Privacy-first Amplitude Android SDK. Public API key only (not the Secret key).
 * Sessions, app lifecycles and screen views only. No element/frustration
 * autocapture, no remote config, no IP or precise-location fields.
 * Does not change any existing screen or layout.
 */
public final class Analytics {
    public static final String API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

    private static volatile Amplitude client;

    private Analytics() {}

    public static void start(Context context) {
        if (client != null) return;
        synchronized (Analytics.class) {
            if (client != null) return;
            TrackingOptions tracking = new TrackingOptions()
                .disableIpAddress()
                .disableCity()
                .disableDma()
                .disableLatLng()
                .disableAdid()
                .disableAppSetId();
            Configuration config = new Configuration(API_KEY, context.getApplicationContext());
            config.setServerZone(ServerZone.US);
            config.setTrackingOptions(tracking);
            config.setUseAdvertisingIdForDeviceId(false);
            config.setUseAppSetIdForDeviceId(false);
            config.setLocationListening(false);
            config.setEnableDiagnostics(false);
            config.setEnableAutocaptureRemoteConfig(false);
            config.setAutocapture(EnumSet.of(
                AutocaptureOption.SESSIONS,
                AutocaptureOption.APP_LIFECYCLES,
                AutocaptureOption.SCREEN_VIEWS
            ));
            client = new Amplitude(config);
        }
    }
}
