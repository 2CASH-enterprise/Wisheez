# Déploiement sur VPS (OVH, DigitalOcean, etc.)

Meta exige un webhook en **HTTPS valide** — pas d'IP nue, pas de certificat auto-signé.
Ce guide suppose un VPS Ubuntu 22.04+ avec un nom de domaine (ou sous-domaine, ex.
`wisheez.votredomaine.com`) déjà pointé vers l'IP du serveur (enregistrement DNS de type A).

## 1. Installer Node.js et les dépendances système

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx

# HyperFrames a besoin de Chrome headless (Puppeteer) et FFmpeg pour le rendu
sudo apt-get install -y ffmpeg
npx puppeteer browsers install chrome
```

## 2. Déployer le code

```bash
cd /var/www
sudo git clone <url-de-votre-repo> wisheez-server
cd wisheez-server
sudo chown -R $USER:$USER .
npm install
npx skills add heygen-com/hyperframes --all   # installe les skills HyperFrames

cp .env.example .env
nano .env   # remplissez vos vraies valeurs
```

## 3. Lancer avec PM2 (garde le serveur actif, redémarre en cas de crash)

```bash
sudo npm install -g pm2
pm2 start server.js --name wisheez
pm2 save
pm2 startup   # affiche une commande à copier-coller pour démarrer au boot du VPS
```

## 4. Configurer Nginx comme reverse proxy

Créez `/etc/nginx/sites-available/wisheez` :

```nginx
server {
    listen 80;
    server_name wisheez.votredomaine.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activez-le puis testez :

```bash
sudo ln -s /etc/nginx/sites-available/wisheez /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Activer HTTPS (obligatoire pour Meta)

```bash
sudo certbot --nginx -d wisheez.votredomaine.com
```

Certbot configure automatiquement le certificat et le renouvellement.

## 6. Configurer le webhook côté Meta

Dans Meta Business Manager → votre app → WhatsApp → Configuration :

- **Callback URL** : `https://wisheez.votredomaine.com/webhook`
- **Verify token** : la même valeur que `WEBHOOK_VERIFY_TOKEN` dans votre `.env`
- Cliquez **Verify and save** — si tout est bon, ça passe au vert immédiatement
- Dans **Webhook fields**, abonnez-vous au champ `messages`

## 7. Tester

Envoyez un message depuis votre téléphone au numéro WhatsApp Business configuré.
Suivez les logs en direct pour vérifier que tout s'enchaîne :

```bash
pm2 logs wisheez
```

## Pense-bête pour la suite

- Le `.env` n'est jamais commité — vérifiez que `.gitignore` contient `.env` et `data/`.
- `data/users.json` est votre base de données actuelle. Sauvegardez-le régulièrement
  (`cp data/users.json data/users.backup.json`) tant qu'il n'y a pas de vraie BDD.
- Le point de paiement Stripe est un TODO explicite dans `server.js` — cherchez
  `TODO` dans le fichier pour le retrouver rapidement.
