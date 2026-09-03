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


export const defaultProducts = [
    { id: 1, name: "T-Shirt", price: 10.00, stock: 5 },
    { id: 2, name: "Mug", price: 6.00, stock: 4 },
    { id: 3, name: "Badge", price: 2.50, stock: 10 },
    { id: 4, name: "Poster", price: 5.00, stock: 3 },
    { id: 5, name: "Tote Bag", price: 8.00, stock: 2 },
    { id: 6, name: "Programme", price: 4.00, stock: 6 }
];

export const currencyFormatter = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP"
});
