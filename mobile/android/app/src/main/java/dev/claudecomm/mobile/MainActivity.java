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
        // sans gestion, l'app revient sur un écran noir définitif. On recrée
        // l'activité — l'UI recharge et le relais embarqué (qui vit dans le
        // processus principal, pas dans le renderer) reste intact ; sinon le
        // redémarrage automatique côté dashboard prend le relais.
        this.bridge.getWebView().setWebViewClient(new BridgeWebViewClient(this.bridge) {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                runOnUiThread(() -> recreate());
                return true; // géré : ne pas tuer l'application
            }
        });
    }
}
