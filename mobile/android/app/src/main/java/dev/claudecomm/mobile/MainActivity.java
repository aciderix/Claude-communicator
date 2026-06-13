package dev.claudecomm.mobile;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

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
                        if (value == null || value.contains("blank")) {
                            runOnUiThread(wv::reload);
                        }
                    });
            } catch (Exception e) {
                runOnUiThread(wv::reload);
            }
        }, 400);
    }
}
