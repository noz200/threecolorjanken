// SupabaseのDashboard URLが次の形なら、projectRefは project/ の後ろです。
// https://supabase.com/dashboard/project/abcdefghijklmnopqrst
//
// URLが見つからない場合は projectRef だけ入れればOKです。
// url は projectRef から自動生成します。

const projectRef = "YOUR_PROJECT_REF";

window.TCJ_SUPABASE_CONFIG = {
  url: `https://${projectRef}.supabase.co`,
  anonKey: "YOUR_SUPABASE_PUBLISHABLE_KEY",
};
