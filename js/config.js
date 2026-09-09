export const supabaseConfig = {
    url: "https://duadghkvimbgffzzxzfo.supabase.co",
    publishableKey: "sb_publishable_7ac6iqUKBWuYzWq1HBTEIw_zLGcirwr"
};

/*
 * Training is deliberately local-only.
 *
 * Every real operational account (Master/Admin/Staff) is now stored in
 * Supabase Auth + public.profiles and must not have a password or email
 * hard-coded into the GitHub Pages application.
 */
export const localTrainingUser = {
    username: "training",
    password: "Training123!",
    role: "training",
    active: true,
    protected: false
};



export const currencyFormatter = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP"
});
