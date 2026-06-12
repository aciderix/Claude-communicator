package dev.claudecomm.mobile;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Mini plugin Capacitor maison pour la survie en arrière-plan :
 *  - enable()/disable() : service de premier plan + wake lock
 *  - status() : constructeur + état de l'optimisation batterie
 *  - requestBatteryExemption() : boîte de dialogue système « ignorer
 *    l'optimisation batterie » pour cette app
 *  - openVendorSettings() : écran constructeur (autostart MIUI, etc.)
 * Côté web : Capacitor.Plugins.KeepAlive.*
 */
@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {

    @PluginMethod
    public void enable(PluginCall call) {
        Intent intent = new Intent(getContext(), RelayForegroundService.class);
        // identifiants du relais local : la notification de statut interroge
        // le relais nativement (indépendant du WebView suspendu)
        intent.putExtra("token", call.getString("token", ""));
        intent.putExtra("port", call.getInt("port", 8787));
        intent.putExtra("channel", call.getString("channel", "default"));
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

    @PluginMethod
    public void status(PluginCall call) {
        boolean ignoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            ignoring = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        }
        JSObject ret = new JSObject();
        ret.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase());
        ret.put("brand", Build.BRAND == null ? "" : Build.BRAND.toLowerCase());
        ret.put("ignoringBatteryOptimizations", ignoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        final String pkg = getContext().getPackageName();
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Impossible d'ouvrir les réglages batterie : " + e2.getMessage());
            }
        }
    }

    /** Écrans « autostart / activité en arrière-plan » propres à chaque
     *  constructeur. Composants connus, essayés dans l'ordre ; repli sur la
     *  fiche de l'app. */
    @PluginMethod
    public void openVendorSettings(PluginCall call) {
        final String pkg = getContext().getPackageName();
        final ComponentName[] candidates = new ComponentName[] {
            // Xiaomi / Redmi / POCO (MIUI) : gestion de l'autostart
            new ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            // MIUI : économiseur de batterie par application
            new ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"),
            // Huawei / Honor
            new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            // Oppo / Realme (ColorOS)
            new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
            // Vivo
            new ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
            // OnePlus
            new ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
            // Samsung
            new ComponentName("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
        };
        for (ComponentName cn : candidates) {
            try {
                Intent intent = new Intent();
                intent.setComponent(cn);
                intent.putExtra("package_name", pkg);
                intent.putExtra("package_label", "claude-comm");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("opened", cn.getPackageName());
                call.resolve(ret);
                return;
            } catch (Exception ignored) { /* écran absent sur cet appareil */ }
        }
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", "app-details");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Aucun écran de réglages accessible : " + e.getMessage());
        }
    }
}
