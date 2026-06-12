package dev.claudecomm.mobile;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Mini plugin Capacitor maison : démarre/arrête le service de premier plan
 * qui garde le relais embarqué en vie écran éteint.
 * Côté web : Capacitor.Plugins.KeepAlive.enable() / .disable()
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        Intent intent = new Intent(getContext(), RelayForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getContext().stopService(new Intent(getContext(), RelayForegroundService.class));
        call.resolve();
    }
}
