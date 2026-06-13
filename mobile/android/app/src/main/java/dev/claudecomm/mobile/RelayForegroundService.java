package dev.claudecomm.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Service de premier plan : maintient le relais claude-comm (moteur Node
 * embarqué + tunnel) en vie écran éteint, et tient une notification de
 * statut vivante (sessions connectées, messages en attente) en interrogeant
 * le relais local — indépendamment du WebView, qu'Android suspend.
 * Nouvelle activité d'une session → notification dédiée.
 */
public class RelayForegroundService extends Service {

    private static final String CHANNEL_ID = "claude_comm_relay";
    private static final String CHANNEL_MSG_ID = "claude_comm_messages";
    private static final int NOTIFICATION_ID = 424242;
    private static final int MSG_NOTIFICATION_ID = 424243;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Thread watcher;
    private volatile boolean running = false;
    private volatile String token = "";
    private volatile int port = 8787;
    private volatile String channel = "default";
    private int lastAgentActivity = -1;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String t = intent.getStringExtra("token");
            if (t != null) token = t;
            port = intent.getIntExtra("port", 8787);
            String c = intent.getStringExtra("channel");
            if (c != null) channel = c;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Relais claude-comm", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Statut du relais en arrière-plan");
            nm.createNotificationChannel(ch);
            NotificationChannel chMsg = new NotificationChannel(
                CHANNEL_MSG_ID, "Messages des sessions", NotificationManager.IMPORTANCE_DEFAULT);
            chMsg.setDescription("Nouveau message d'une session Claude");
            nm.createNotificationChannel(chMsg);
        }

        startForeground(NOTIFICATION_ID, buildStatusNotification("Relais actif — démarrage…"));

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

        startWatcher();
        return START_STICKY;
    }

    private Notification buildStatusNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return b.setContentTitle("claude-comm")
            .setContentText(text)
            .setSmallIcon(getResources().getIdentifier("ic_stat_notify", "drawable", getPackageName()))
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }

    private void notifyNewActivity(String author, String preview) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_MSG_ID)
            : new Notification.Builder(this);
        Notification n = b.setContentTitle("💬 " + author)
            .setContentText(preview)
            .setSmallIcon(getResources().getIdentifier("ic_stat_notify", "drawable", getPackageName()))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        getSystemService(NotificationManager.class).notify(MSG_NOTIFICATION_ID, n);
    }

    /** Interroge le relais local toutes les 20 s : met à jour la notification
     *  de statut, et signale les nouveaux messages de sessions. */
    private void startWatcher() {
        if (running) return;
        running = true;
        watcher = new Thread(() -> {
            while (running) {
                try {
                    JSONObject state = fetchState();
                    if (state != null) {
                        JSONArray sessions = state.optJSONArray("sessions");
                        int nbSessions = sessions == null ? 0 : sessions.length();
                        JSONObject user = state.optJSONObject("user");
                        int openForAgents = 0;
                        int agentActivity = 0;
                        String lastAuthor = null;
                        String lastPreview = null;
                        if (user != null) {
                            JSONArray items = user.getJSONObject("msgs").getJSONArray("items");
                            for (int i = 0; i < items.length(); i++) {
                                JSONObject m = items.getJSONObject(i);
                                String from = m.optString("from", "user");
                                if ("user".equals(from) && "open".equals(m.optString("status"))) openForAgents++;
                                if (!"user".equals(from)) {
                                    agentActivity++;
                                    lastAuthor = from;
                                    lastPreview = m.optString("body", "");
                                }
                                JSONArray replies = m.optJSONArray("replies");
                                if (replies != null) {
                                    agentActivity += replies.length();
                                    if (replies.length() > 0) {
                                        JSONObject r = replies.getJSONObject(replies.length() - 1);
                                        lastAuthor = r.optString("by", lastAuthor);
                                        lastPreview = r.optString("body", lastPreview);
                                    }
                                }
                            }
                            JSONArray qs = user.getJSONObject("questions").getJSONArray("items");
                            int openQ = 0;
                            for (int i = 0; i < qs.length(); i++) {
                                if ("open".equals(qs.getJSONObject(i).optString("status"))) openQ++;
                            }
                            String text = nbSessions + " session(s)"
                                + (openQ > 0 ? " · " + openQ + " question(s) pour toi" : "")
                                + (openForAgents > 0 ? " · " + openForAgents + " message(s) sans réponse" : "");
                            getSystemService(NotificationManager.class)
                                .notify(NOTIFICATION_ID, buildStatusNotification(text));
                            if (lastAgentActivity >= 0 && agentActivity > lastAgentActivity && lastAuthor != null) {
                                String preview = lastPreview == null ? "" :
                                    (lastPreview.length() > 80 ? lastPreview.substring(0, 80) + "…" : lastPreview);
                                notifyNewActivity(lastAuthor, preview);
                            }
                            lastAgentActivity = agentActivity;
                        }
                    } else {
                        getSystemService(NotificationManager.class)
                            .notify(NOTIFICATION_ID, buildStatusNotification("Relais injoignable…"));
                    }
                } catch (Exception ignored) { /* meilleure chance au prochain tour */ }
                try { Thread.sleep(20000); } catch (InterruptedException e) { return; }
            }
        }, "claude-comm-watcher");
        watcher.setDaemon(true);
        watcher.start();
    }

    private JSONObject fetchState() {
        if (token == null || token.isEmpty()) return null;
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http://127.0.0.1:" + port + "/c/" + channel + "/state");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            if (conn.getResponseCode() != 200) return null;
            BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (watcher != null) watcher.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }
}
