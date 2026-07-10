# Setup — Ubuntu server

## 1. Prereqs (once)

```bash
# Node 20+ via nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2 process manager
sudo npm i -g pm2
```

## 2. Get your keys

- **BOT_TOKEN**: Telegram → message @BotFather → /newbot → follow prompts → copy token
- **HELIUS_API_KEY** (optional but recommended): helius.dev → sign up free → copy key from dashboard. Without it the holder check silently skips and everything else still works.

## 3. Deploy

```bash
# upload the zip, then:
unzip rick-clone.zip && cd rick-clone
npm install

# env file
cp .env.example .env
nano .env   # paste BOT_TOKEN and HELIUS_API_KEY
```

## 4. Run under pm2

```bash
pm2 start "npx tsx src/index.ts" --name degen-bot --env-file .env
pm2 save
pm2 startup   # run the command it prints — auto-start on reboot
```

If your pm2 version doesn't support --env-file:

```bash
export $(cat .env | xargs) && pm2 start "npx tsx src/index.ts" --name degen-bot
pm2 save
```

## 5. Check it

```bash
pm2 logs degen-bot
```

Then DM your bot on Telegram: `microcaps under 250k, fresh, like 10`

## Ops notes

- Long polling, so no domain, no webhook, no open ports, no nginx. Works behind NAT.
- `pm2 restart degen-bot` after any code edit.
- DexScreener rate limit is ~300 req/min — a personal bot won't get near it.
- If replies come back empty, loosen the filters in `src/ranker.ts` (the 40k mcap floor and 0.5 vol/mcap gate are strict on purpose).

## Tuning cheatsheet (src/ranker.ts)

| Line | What it does | Loosen if |
|---|---|---|
| `mcap < 40_000` | rug floor | you want sub-40k lottery tickets |
| `liq < 5_000` | liquidity floor | fresh mints getting filtered |
| `volToMcap < 0.5` | attention gate | too few results |
| `top10Pct > 40` | holder trap threshold | Solana results all buried |
