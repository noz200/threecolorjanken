// SupabaseのDashboard URLが次の形なら、projectRefは project/ の後ろです。
// https://supabase.com/dashboard/project/abcdefghijklmnopqrst
//
// URLが見つからない場合は projectRef だけ入れればOKです。
// url は projectRef から自動生成します。

const projectRef = "zyudljqybwobrkkaftnn";

window.TCJ_SUPABASE_CONFIG = {
  url: `https://${projectRef}.supabase.co`,
  anonKey: "sb_publishable_ZOXOtLZHDGkc5c_C0sBcNg_bwlJ8hcv",
};
