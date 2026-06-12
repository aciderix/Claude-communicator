package dev.claudecomm.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Service de premier plan : maintient le relais claude-comm (moteur Node
 * embarqué + tunnel) en vie quand l'écran s'éteint ou que l'app passe en
 * arrière-plan. Notification permanente + wake lock partiel (CPU) +
 * WifiLock haute performance (le WiFi est endormi séparément du CPU —
 * vérifié en test réel : sans lui, MIUI coupe le réseau écran éteint).
 */
public class RelayForegroundService extends Service {

    private static final String CHANNEL_ID = "claude_comm_relay";
    private static final int NOTIFICATION_ID = 424242;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Relais claude-comm", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Maintient le relais joignable en arrière-plan");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Notification notification = builder
            .setContentTitle("claude-comm")
            .setContentText("Relais actif — sessions et dashboard joignables")
            .setSmallIcon(getApplicationInfo().icon)
            .setOngoing(true)
            .build();
        startForeground(NOTIFICATION_ID, notification);

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "claude-comm:relay");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "claude-comm:wifi");
            wifiLock.setReferenceCounted(false);
        }
        if (!wifiLock.isHeld()) wifiLock.acquire();

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }
}
