# claude-comm — interface web (React)

Interface unique de claude-comm, utilisée par :

- le **relais** (`relay.js` sert `web/dist/` à la racine quand il existe,
  sinon il retombe sur le dashboard vanilla de `public/`) ;
- l'**app mobile** (Capacitor — `mobile/copy-assets.js` construit ce
  projet et place `dist/` dans le webview) ;
- l'**app desktop** (Electron charge l'URL du relais, donc cette UI).

```bash
npm install
npm run build     # → dist/, ramassé par le relais et les apps
npm run dev       # développement (pointez l'écran de connexion sur un relais)
```

Origine : mockup AI Studio fourni par l'utilisateur, rebranché sur l'API
réelle du relais (long-poll /state, claim, questions, diff, standup,
hébergement embarqué mobile avec bridge + canal HTTP de secours).
