export const supabaseConfig = {
    url: "https://zdxduhnfjebahfzuqttk.supabase.co",
    publishableKey: "sb_publishable_ReTBviIlpav9HsnAqcxnSA_l6yHSGhy"
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

export const discountAuthorisers = [
    { username: "master", pin: "261196" },
    { username: "admin", pin: "1234" },
    { username: "summer", pin: "290304" },
    { username: "lynda", pin: "2509" }
];


export const currencyFormatter = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP"
});
