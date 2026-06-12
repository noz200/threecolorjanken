# 三色じゃんけん 複数人対戦

GitHub Pages + Supabaseで動く、3人オンライン対戦版の三色じゃんけんです。  
GitHub Pagesは静的ファイルを配るだけなので、待機列・マッチング・ゲーム状態の共有はSupabaseに置いています。人類は静的サイトにリアルタイム通信まで求めがちですが、さすがに念力では動きません。

## ルール

- 各プレイヤーは `白/青/赤 × グー/チョキ/パー` の9枚を持つ
- 白は1点、青は2点、赤は3点
- 1番手、2番手、3番手の順にカードを出す
- 先に出されたカードは「色」だけ公開される
- 3人が出し終わったら手を公開する
- 全員同じ手、またはグー・チョキ・パーが全部出たらあいこ
- 2種類だけ出た場合、勝つ手を出した人が得点
- 勝者が1人なら、その人が次ラウンドの1番手
- 勝者が2人なら、獲得点が高い勝者が次ラウンドの1番手。同点なら前の順番が早い方を先にする
- あいこなら順番維持
- 全9ラウンドで合計点が高い人の勝ち

## GitHub Pagesで動かす手順

### 1. SupabaseでSQLを実行

SupabaseのSQL Editorで、次のファイルをそのまま実行してください。

```text
supabase/schema.sql
```

作られるもの:

- `tcj_waiting`: 待機中プレイヤー
- `tcj_games`: ゲーム状態
- `tcj_presence`: 接続・タブ状態
- `tcj_try_match()`: 3人そろったらゲームを作るRPC
- Realtime対象: `tcj_waiting`, `tcj_games`

### 2. Supabase設定を入れる

`supabase-config.js` を自分のSupabase情報に変更します。  
URLがDashboardに見つからない場合は、Dashboard URLの `project/` の後ろにあるProject refだけ入れればOKです。

Dashboard URLがこれなら、

```text
https://supabase.com/dashboard/project/abcdefghijklmnopqrst
```

`projectRef` はこれです。

```text
abcdefghijklmnopqrst
```

設定例:

```js
const projectRef = "abcdefghijklmnopqrst";

window.TCJ_SUPABASE_CONFIG = {
  url: `https://${projectRef}.supabase.co`,
  anonKey: "sb_publishable_xxxxxxxxxxxxxxxxx",
};
```

`anonKey` にはSupabaseの `Publishable key` を入れてください。`Secret key` は絶対に入れないでください。

### 3. GitHub Pagesを有効化

GitHubのリポジトリ設定で次を選びます。

- Settings
- Pages
- Build and deployment
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/root`

公開URLはだいたい次です。

```text
https://noz200.github.io/threecolorjanken/
```

## マッチング仕様

- 名前を入力して「参加」を押すと待機キューに入る
- 待機中の有効プレイヤーが3人になった瞬間にマッチングする
- 待機中にタブを閉じた、通信が切れた、非表示のまま一定時間経ったプレイヤーはマッチング対象から外れる
- 対戦中に接続が切れたプレイヤーがいる場合、他プレイヤー側の監視でゲームを中断する

## 注意

この実装は、友達同士で遊ぶための軽量版です。  
GitHub PagesからSupabaseのPublishable keyを使って直接DBを読む構成なので、ブラウザの開発者ツールを開けばゲーム状態は見えます。つまり本気の不正対策はありません。まあブラウザだけで公平なオンラインカードゲームを作ろうとすると、だいたいここで人類の欲望に負けます。

本気で不正対策するなら、カード選択・手札・勝敗判定をサーバー側、またはSupabase Edge Functions側に寄せてください。
