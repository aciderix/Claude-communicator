package dev.claudecomm.mobile;

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

        // Correctif MIUI « WebView noir au retour » : le renderer est souvent
        // VIVANT mais le compositeur ne redessine pas la surface. Re-dessin
        // forcé par bascule de visibilité + invalidation.
        wv.setVisibility(android.view.View.GONE);
        wv.postDelayed(() -> {
            wv.setVisibility(android.view.View.VISIBLE);
            wv.postInvalidate();
        }, 60);

        // Et si le renderer est réellement mort : sonde JS, recréation.
        final boolean[] alive = { false };
        try {
            wv.evaluateJavascript("1+1", value -> alive[0] = true);
        } catch (Exception e) {
            alive[0] = false;
        }
        wv.postDelayed(() -> {
            if (!alive[0]) {
                runOnUiThread(this::recreate);
            }
        }, 3000);
    }
}
