package dev.claudecomm.mobile;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {

    /** Pousse une ligne de diagnostic vers le relais local (lisible à distance
     *  via le tunnel : débogage natif sans PC ni ADB). Best effort, async. */
    private void nativeLog(String line) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                SharedPreferences p = getSharedPreferences("claude_comm", Context.MODE_PRIVATE);
                String token = p.getString("token", "");
                int port = p.getInt("port", 8787);
                if (token.isEmpty()) return;
                URL url = new URL("http://127.0.0.1:" + port + "/native-log");
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Content-Type", "application/json");
                String json = "{\"line\":\"" + line.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(json.getBytes("UTF-8"));
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);

        // Android 13+ : la permission notifications doit être demandée à
        // l'exécution, sinon la notification de statut (sessions, messages)
        // échoue silencieusement.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                   != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 1001);
        }

        // Android peut tuer le processus de rendu du WebView en arrière-plan :
        // sans gestion, l'app revient sur un écran noir définitif.
        this.bridge.getWebView().setWebViewClient(new BridgeWebViewClient(this.bridge) {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                nativeLog("renderer WebView tue (crash=" + (detail != null && detail.didCrash()) + ") -> recreate");
                runOnUiThread(() -> recreate());
                return true; // géré : ne pas tuer l'application
            }
        });
    }

    /**
     * Défense complémentaire (constaté en test réel : l'écran noir survit au
     * correctif ci-dessus, le callback pouvant être repris par Capacitor) :
     * à chaque retour au premier plan, on sonde le moteur JS du WebView ;
     * s'il ne répond pas en 3 s, le renderer est mort → recréation.
     */
    @Override
    public void onResume() {
        super.onResume();
        final WebView wv = this.bridge.getWebView();
        if (wv == null) return;
        nativeLog("onResume");

        // Diagnostic confirmé en test réel (3 défenses précédentes inefficaces) :
        // le moteur JS reste VIVANT (1+1 répond) mais le CONTENU de la page est
        // purgé ou non peint par MIUI -> écran noir. Remède en couches :

        // 1) relancer le cycle de vie propre du WebView (Capacitor le met en
        //    pause en arrière-plan : rendu et timers JS gelés).
        try {
            wv.onResume();
            wv.resumeTimers();
        } catch (Exception ignored) { /* selon version WebView */ }

        // 2) re-dessin forcé du compositeur (cas « surface non repeinte »).
        wv.setVisibility(android.view.View.GONE);
        wv.postDelayed(() -> {
            wv.setVisibility(android.view.View.VISIBLE);
            wv.postInvalidate();
        }, 50);

        // 3) sonde de CONTENU (pas seulement du moteur JS) : si la racine React
        //    est vide -> la page a été purgée -> rechargement (l'app relit
        //    localStorage et se reconnecte seule, rien n'est perdu).
        wv.postDelayed(() -> {
            try {
                wv.evaluateJavascript(
                    "(function(){var r=document.getElementById('root');"
                        + "return (r && r.children && r.children.length>0) ? 'ok' : 'blank';})()",
                    value -> {
                        nativeLog("contenu racine=" + value);
                        if (value == null || value.contains("blank")) {
                            nativeLog("page vide -> rechargement WebView");
                            runOnUiThread(wv::reload);
                        }
                    });
            } catch (Exception e) {
                nativeLog("sonde contenu echec -> rechargement : " + e.getMessage());
                runOnUiThread(wv::reload);
            }
        }, 400);
    }
}
