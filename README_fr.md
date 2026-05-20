# 123456btc-node

> **[English](README.md)** | [中文](README_zh.md) | [فارسی](README_fa.md) | [မြန်မာ](README_my.md) | [العربية](README_ar.md) | [Français](README_fr.md)

> **Réseau Décentralisé de Distribution de Stratégies**
>
> Déployez votre propre nœud. Fixez votre propre prix. Construisez votre propre cercle.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-9945FF.svg)](https://solana.com)

---

## Qu'est-ce que c'est ?

Un réseau P2P entièrement décentralisé pour la distribution de signaux de trading. Déployez votre propre nœud, publiez des stratégies et collectez des abonnements en tokens BBT — aucun serveur central, aucune commission de plateforme.

**Comment ça fonctionne :**

1. Vous déployez un **nœud Provider**
2. Vous créez des stratégies et fixez les prix en BBT
3. Les utilisateurs découvrent votre nœud dans des communautés privées
4. Les utilisateurs s'abonnent en envoyant des BBT à votre portefeuille
5. Votre système pousse les signaux, ils les reçoivent en temps réel
6. Vous gérez vos BBT selon vos propres besoins

**Trois couches de produits :**

- **Boîtes Mystères** — Coupures fixes (1 / 10 / 100 / 1K / 10K USDT), ouvrez pour obtenir des NFT d'abonnement aux stratégies
- **Abonnements aux Stratégies** — Par jour, par signal, ou gratuit
- **Réseau de Nœuds** — Déployez votre propre nœud, fixez vos propres prix

---

## Architecture du Réseau

```
                         ┌─────────────────┐
                         │   Seed Node     │
                         └────────┬────────┘
                                  │
                   ┌──────────────┼──────────────┐
                   │              │              │
          ┌────────▼─────┐ ┌──────▼──────┐ ┌────▼─────────┐
          │   Provider   │ │    Relay    │ │  Subscriber  │
          └───────┬──────┘ └──────┬──────┘ └───────┬──────┘
                  │   Gossip Protocol (libp2p)      │
                  │               │                 │
          ┌───────▼──────┐ ┌──────▼──────┐ ┌───────▼──────┐
          │  Subscriber  │ │  Subscriber │ │ Telegram Bot │
          └──────────────┘ └─────────────┘ └──────────────┘
```

### Rôles des Nœuds

| Rôle | Ce que vous faites | Qui l'exploite |
|------|-------------------|----------------|
| **Provider** | Créer des stratégies, publier des signaux, collecter des BBT | Équipes quantitatives |
| **Subscriber** | Recevoir des signaux, gérer les abonnements | Traders |
| **Relay** | Transmettre des signaux, étendre la couverture | Bénévoles communautaires |

### Propagation des Signaux

1. Le Provider pousse le signal via l'API REST (signature de portefeuille Ed25519)
2. Le nœud valide, persiste dans SQLite, diffuse localement via WebSocket
3. Le signal se propage via libp2p GossipSub (TTL=5 sauts)
4. Chaque nœud déduplique et vérifie la signature HMAC

---

## Série de Boîtes Mystères

Boîtes mystères à coupures fixes. Ouvrez pour obtenir des NFT d'abonnement aux stratégies, échangeables sur le marché secondaire.

| Série | Valeur (USDT) | BBT | Frais |
|-------|--------------|-----|-------|
| Bronze | 1 | 100 | 3% |
| Argent | 10 | 1 000 | 2.5% |
| Or | 100 | 10 000 | 2% |
| Platine | 1 000 | 100 000 | 1.5% |
| Diamant | 10 000 | 1 000 000 | 1% |

### Contenu

| Rareté | Contenu | Probabilité | Réf. Marché |
|--------|---------|-------------|-------------|
| Blanc | Essai 1 jour | 40% | 10 BBT |
| Vert | Abonnement 7 jours | 30% | 50 BBT |
| Bleu | Abonnement 30 jours | 15% | 200 BBT |
| Violet | Abonnement 90 jours | 10% | 800 BBT |
| Orange | Abonnement 365 jours | 4% | 3 000 BBT |
| Caché | Permanent + invitation privée | 1% | 10 000+ BBT |

**Synthèse :** 5 Blanc -> 1 Vert, 3 Vert -> 1 Bleu. Crée des scénarios de destruction.

---

## Démarrage Rapide

### Docker

```bash
git clone <repo-url> && cd 123456btc-node
cp .env.example .env
# Modifiez .env avec votre portefeuille et vos paramètres
docker compose up -d
curl http://localhost:1119/health
```

### Local

```bash
npm ci && npm run build

# Initialisation
123456btc-node init --name "MonNœud" --wallet "VOTRE_PORTEFEUILLE_SOLANA" --rpc "https://api.devnet.solana.com"

# Créer une stratégie
123456btc-node strategy:create --name "BTC Alpha" --symbol "BTCUSDT" --pricing daily_bbt --price-day 100

# Démarrer
123456btc-node serve
```

---

## Commandes CLI

### Nœud

```bash
123456btc-node init              # Initialiser le nœud
123456btc-node config            # Voir/mettre à jour la configuration
123456btc-node serve             # Démarrer le nœud
123456btc-node emergency-wipe    # DÉTRUIRE toutes les données (irréversible)
```

### Stratégies

```bash
123456btc-node strategy:create   # Créer une stratégie
123456btc-node strategy:list     # Lister les stratégies
123456btc-node strategy bind     # Lier un Agent à une stratégie
123456btc-node strategy bundles  # Voir les forfaits
123456btc-node strategy bundle   # Acheter un forfait
```

### Identité Agent

```bash
123456btc-node agent register    # Enregistrer un Agent (Ed25519)
123456btc-node agent status      # Voir la réputation
```

### Boîtes Mystères

```bash
123456btc-node blindbox create   # Créer une boîte mystère
123456btc-node blindbox list     # Annonces du marché
123456btc-node blindbox buy      # Acheter une boîte mystère
123456btc-node blindbox stats    # Statistiques du marché
```

### Serveur MCP

```bash
123456btc-node mcp               # Démarrer le serveur MCP pour les Agents IA
```

---

## API REST

| Méthode | Chemin | Description |
|---------|--------|-------------|
| `GET` | `/health` | Vérification de santé |
| `GET` | `/strategies` | Lister les stratégies |
| `POST` | `/strategies` | Créer une stratégie |
| `POST` | `/signals` | Publier un signal |
| `GET` | `/signals/:strategyId` | Historique des signaux |
| `POST` | `/subscriptions` | Créer un abonnement |
| `GET` | `/subscriptions` | Lister les abonnements |
| `POST` | `/users/register` | Enregistrer un portefeuille |
| `GET` | `/user/balance` | Solde on-chain |
| `GET` | `/admin/earnings` | Tableau de bord des gains |

### WebSocket

| Chemin | Description |
|--------|-------------|
| `ws://host:port` | Push de signaux en temps réel |
| `ws://host:port/peer` | Mesh gossip P2P |

### Exemple d'Authentification

```bash
curl -X POST http://localhost:1119/signals \
  -H "x-wallet: <PORTEFEUILLE>" \
  -H "x-wallet-signature: <SIG_ED25519>" \
  -H "x-wallet-timestamp: <TIMESTAMP>" \
  -d '{"strategy_id":"...","symbol":"BTCUSDT","decision":"BUY","confidence":0.85}'
```

---

## Token BBT

**Mint :** `3s4AK2x2nGkKP8ZADbcKuhdPr3coSuh1XnwZEzWgpump` | **Décimales :** 6 | **Chaîne :** Solana

### Pourquoi le BBT

- **Standardisé** — 1 BBT = 1 BBT, pas de complexité de taux de change
- **Divisible** — 6 décimales, n'importe quel montant
- **Transparent mais contextuel** — Vérifiable on-chain, chaque transaction a une justification commerciale
- **Mondial** — 24/7, pas de SWIFT, pas d'heures bancaires

### Mécanisme de Destruction

| Scénario | Destruction % |
|----------|---------------|
| Achat de boîte mystère | 30% |
| Abonnement à une stratégie | 20% |
| Revente de NFT | 5% |
| Frais de service du nœud | 10% |
| Revenus du protocole | 50% rachat et destruction |

Offre totale : 1 milliard, aucune création supplémentaire.

---

## Abonnement & Règlement

### Modèles de Facturation

| Modèle | Description |
|--------|-------------|
| `daily_bbt` | Abonnement quotidien, l'utilisateur envoie des BBT par jour |
| `per_signal_bbt` | Déduction par signal à partir du solde pré-déposé |
| `free` | Gratuit, pas de facturation |

### Flux de Règlement

1. L'utilisateur sélectionne une stratégie, crée un abonnement
2. Le nœud retourne : portefeuille Provider + montant + Memo
3. L'utilisateur envoie des BBT avec le Memo : `BBT-SUB|{sub_id}|{strategy_id}|{wallet}`
4. BillingCron interroge la chaîne toutes les 60s, correspond au Memo, active l'abonnement

---

## Système d'Identité Agent

- **Enregistrement** — Signature de portefeuille Ed25519, identité on-chain unique
- **Réputation** — Taux de réussite des trades, précision des signaux, temps de fonctionnement, poids du stake
- **NFT** — Création de NFT Bot ID, vérifiable on-chain
- **Liaison** — Agent -> Stratégie, définir le mode d'exécution (auto/semi_auto/manual) et la part des frais
- **Forfaits** — Produits combinés NFT de stratégie + Boîte mystère

---

## Sécurité

- **Authentification par portefeuille** — Signatures Ed25519, pas de nom d'utilisateur/mot de passe
- **Signature de messages** — HMAC-SHA256, anti-fraude, anti-rejeu
- **Chiffrement des données** — AES-256 sur les champs sensibles, clés non présentes sur le serveur
- **Politique de journalisation** — Nettoyage automatique, rotation de 7 jours et destruction
- **Effacement d'urgence** — `kill -USR1 <pid>` met à zéro et supprime la base de données, les journaux, la configuration
- **Docker non-root** — UID 1001, privilèges minimaux
- **Chiffrement P2P** — Protocole libp2p noise, gossip chiffré de bout en bout

Checklist complète : [SECURITY.md](SECURITY.md)

---

## Bot Telegram

Activez en définissant `TELEGRAM_BOT_TOKEN` dans `.env`.

| Commande | Description |
|----------|-------------|
| `/wallet <adresse>` | Lier un portefeuille |
| `/strategies` | Lister les stratégies |
| `/subscribe <id> <jours>` | S'abonner |
| `/signals` | Signaux récents |
| `/status` | Statut de l'abonnement |

---

## Intégration MCP

Serveur MCP intégré pour les Agents IA (Claude Code, Cursor, etc.).

```json
{
  "mcpServers": {
    "123456btc": {
      "command": "npx",
      "args": ["tsx", "/path/to/src/mcp/server.ts"]
    }
  }
}
```

| Outil | Description |
|-------|-------------|
| `list_strategies` | Lister les stratégies |
| `create_strategy` | Créer une stratégie |
| `publish_signal` | Publier un signal |
| `get_signals` | Historique des signaux |
| `my_subscriptions` | Mes abonnements |
| `register_wallet` | Enregistrer un portefeuille |
| `node_status` | État du nœud |

---

## Variables d'Environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `BBT_PROVIDER_ID` | (requis) | ID du Provider |
| `BBT_WALLET_ADDRESS` | (requis) | Votre portefeuille Solana |
| `BBT_NODE_PORT` | `1119` | Port |
| `BBT_SOLANA_RPC` | mainnet | RPC Solana |
| `BBT_SETTLEMENT_MODE` | `memo` | Mode de règlement |
| `BBT_SEEDS` | (vide) | URLs des nœuds seed |
| `TELEGRAM_BOT_TOKEN` | (vide) | Bot Telegram |
| `ENABLE_AUTO_EXECUTION` | `false` | Exécution automatique via Jupiter |
| `BBT_LOG_LEVEL` | `info` | Niveau de journalisation |

Liste complète : [.env.example](.env.example)

---

## Stack Technique

Node.js 20+ / TypeScript / SQLite / Solana / libp2p GossipSub / Commander / Pino / Telegraf / tsyringe / Jupiter / MCP

---

## Documentation

| Document | Contenu |
|----------|---------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Topologie du réseau, propagation des signaux, modèle de données |
| [SIGNAL_STANDARD.md](docs/SIGNAL_STANDARD.md) | Standard de signal ISES v1 |
| [MCP-INTEGRATION.md](docs/MCP-INTEGRATION.md) | Intégration Agent IA |
| [DEPLOY.md](DEPLOY.md) | Docker, HTTPS, sauvegarde |
| [SECURITY.md](SECURITY.md) | Liste de contrôle d'audit de sécurité |

---

## Tests

```bash
npm test              # Exécuter tous les tests
npm run test:watch    # Mode surveillance
npm run lint          # Lint
```

---

## Licence

Apache License 2.0
