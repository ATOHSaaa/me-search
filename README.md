# .me search

個人サイトを、スクショとタイトルと URL の枠で並べる一覧。

```sh
npm run dev
npm run build
```

## GitHub Pages

`main` へ push すると [GitHub Actions](.github/workflows/deploy-pages.yml) がビルドして Pages に公開します。

1. GitHub のリポジトリ **Settings → Pages → Build and deployment** で **GitHub Actions** を選ぶ（初回のみ）
2. 本番の計測 ID はリポジトリ **Secrets** に `PUBLIC_GA_MEASUREMENT_ID` / `PUBLIC_CLARITY_PROJECT_ID` を登録（任意）
3. プロジェクトページの URL は `https://<ユーザー名>.github.io/<リポジトリ名>/`（`GITHUB_REPOSITORY` から `base` を自動設定）

ローカルでは `base` は `/` のままです。

掲載を足すときは `src/data/sites.json` に `url` / `shot` / `addedAt`（ISO日時）を追加して、`npm run shoot` を走らせる。カードのタイトルはビルド時に各サイトの HTML `<title>` を取得して表示する（JS で変わる場合は `npm run titles` で `sites.json` を同期）。一覧は `addedAt` の新しい順。

```sh
npm run shoot
```

画像は静止画 `<shot>.webp` / `<shot>-mobile.webp` と、スクロール（または内部遷移）の GIF `<shot>.gif` / `<shot>-mobile.gif`。ヘッダーで `▬`/`▮`（PC横・スマホ）と `▦`/`▶`（静止画・GIF）を切替。
