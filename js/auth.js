import { dom } from "./dom.js";
import { state } from "./state.js";
import { clearCart } from "./till.js";
import { supabaseConfig } from "./config.js";

const CLOUD_ACCESS_TOKEN_KEY = "merchTillCloudAccessToken";
const CLOUD_REFRESH_TOKEN_KEY = "merchTillCloudRefreshToken";

export function showApplication(username) {
    dom.loginScreen.hidden = true;
    dom.appScreen.hidden = false;
    dom.loggedInUser.textContent = username;

    document.dispatchEvent(new CustomEvent("user-role-changed"));
}

export function showLogin() {
    dom.appScreen.hidden = true;
    dom.loginScreen.hidden = false;
    dom.loginForm.reset();
    dom.errorMessage.textContent = "";
}

function isCloudUsername(username) {
    return Boolean(
        supabaseConfig.cloudUsers[
            String(username || "").toLowerCase()
        ]
    );
}

function getCloudUserConfig(username) {
    return supabaseConfig.cloudUsers[
        String(username || "").toLowerCase()
    ] || null;
}

function clearCloudSession() {
    sessionStorage.removeItem(CLOUD_ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(CLOUD_REFRESH_TOKEN_KEY);
}

async function signInToSupabase(username, password) {
    const cloudUser = getCloudUserConfig(username);

    if (!cloudUser) {
        throw new Error("Cloud user is not configured.");
    }

    const response = await fetch(
        `${supabaseConfig.url}/auth/v1/token?grant_type=password`,
        {
            method: "POST",
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email: cloudUser.email,
                password: password
            })
        }
    );

    if (!response.ok) {
        if (response.status === 400) {
            throw new Error("Incorrect username or password.");
        }

        throw new Error(
            "Cloud login could not be completed. Check the internet connection."
        );
    }

    const authData = await response.json();

    if (!authData.access_token || !authData.user?.id) {
        throw new Error("Supabase did not return a valid login session.");
    }

    const profileResponse = await fetch(
        `${supabaseConfig.url}/rest/v1/profiles` +
        `?id=eq.${encodeURIComponent(authData.user.id)}` +
        `&select=username,role,active`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${authData.access_token}`,
                "Accept": "application/json"
            }
        }
    );

    if (!profileResponse.ok) {
        throw new Error(
            "Your cloud profile could not be loaded."
        );
    }

    const profiles = await profileResponse.json();
    const profile = profiles[0];

    if (
        !profile ||
        !profile.active ||
        profile.username.toLowerCase() !== username.toLowerCase()
    ) {
        throw new Error(
            "This cloud account is not authorised for this Till login."
        );
    }

    sessionStorage.setItem(
        CLOUD_ACCESS_TOKEN_KEY,
        authData.access_token
    );

    if (authData.refresh_token) {
        sessionStorage.setItem(
            CLOUD_REFRESH_TOKEN_KEY,
            authData.refresh_token
        );
    }

    return {
        username: profile.username,
        role: profile.role
    };
}

async function loadCloudProfile(accessToken, username) {
    const response = await fetch(
        `${supabaseConfig.url}/auth/v1/user`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`
            }
        }
    );

    if (!response.ok) {
        return null;
    }

    const authUser = await response.json();

    if (!authUser?.id) {
        return null;
    }

    const profileResponse = await fetch(
        `${supabaseConfig.url}/rest/v1/profiles` +
        `?id=eq.${encodeURIComponent(authUser.id)}` +
        `&select=username,role,active`,
        {
            headers: {
                "apikey": supabaseConfig.publishableKey,
                "Authorization": `Bearer ${accessToken}`,
                "Accept": "application/json"
            }
        }
    );

    if (!profileResponse.ok) {
        return null;
    }

    const profiles = await profileResponse.json();
    const profile = profiles[0];

    if (
        !profile ||
        !profile.active ||
        profile.username.toLowerCase() !== username.toLowerCase()
    ) {
        return null;
    }

    return profile;
}

async function restoreCloudSession(username) {
    const accessToken = sessionStorage.getItem(
        CLOUD_ACCESS_TOKEN_KEY
    );

    if (!accessToken) {
        return null;
    }

    return loadCloudProfile(accessToken, username);
}

export async function validateSavedSession() {
    const savedUsername =
        sessionStorage.getItem("merchTillUsername");

    if (!savedUsername) {
        return;
    }

    if (isCloudUsername(savedUsername)) {
        try {
            const profile = await restoreCloudSession(
                savedUsername
            );

            if (!profile) {
                sessionStorage.clear();
                showLogin();
                return;
            }

            sessionStorage.setItem(
                "merchTillRole",
                profile.role
            );
            showApplication(profile.username);
            return;
        } catch (error) {
            console.error(
                "Saved cloud session could not be restored:",
                error
            );
            sessionStorage.clear();
            showLogin();
            return;
        }
    }

    const user = state.users.find(function (item) {
        return (
            item.username === savedUsername &&
            item.active
        );
    });

    if (!user) {
        sessionStorage.clear();
        showLogin();
        return;
    }

    sessionStorage.setItem(
        "merchTillRole",
        user.role
    );
    showApplication(user.username);
}

export function initialiseAuthentication() {
    dom.loginForm.addEventListener(
        "submit",
        async function (event) {
            event.preventDefault();

            const enteredUsername =
                document
                    .getElementById("username")
                    .value
                    .trim();

            const enteredPassword =
                document.getElementById("password").value;

            dom.errorMessage.textContent = "";

            if (isCloudUsername(enteredUsername)) {
                try {
                    const cloudProfile =
                        await signInToSupabase(
                            enteredUsername,
                            enteredPassword
                        );

                    sessionStorage.setItem(
                        "merchTillLoggedIn",
                        "true"
                    );
                    sessionStorage.setItem(
                        "merchTillUsername",
                        cloudProfile.username
                    );
                    sessionStorage.setItem(
                        "merchTillRole",
                        cloudProfile.role
                    );

                    showApplication(
                        cloudProfile.username
                    );
                    return;
                } catch (error) {
                    console.error(
                        "Cloud login failed:",
                        error
                    );

                    dom.errorMessage.textContent =
                        error.message ||
                        "Incorrect username or password.";

                    document.getElementById(
                        "password"
                    ).value = "";

                    return;
                }
            }

            const matchingUser =
                state.users.find(function (user) {
                    return (
                        user.active &&
                        user.username === enteredUsername &&
                        user.password === enteredPassword
                    );
                });

            if (matchingUser) {
                sessionStorage.setItem(
                    "merchTillLoggedIn",
                    "true"
                );
                sessionStorage.setItem(
                    "merchTillUsername",
                    matchingUser.username
                );
                sessionStorage.setItem(
                    "merchTillRole",
                    matchingUser.role
                );
                showApplication(
                    matchingUser.username
                );
                return;
            }

            dom.errorMessage.textContent =
                "Incorrect username or password.";

            document.getElementById(
                "password"
            ).value = "";
        }
    );

    dom.logoutButton.addEventListener(
        "click",
        async function () {
            const accessToken =
                sessionStorage.getItem(
                    CLOUD_ACCESS_TOKEN_KEY
                );

            if (accessToken) {
                try {
                    await fetch(
                        `${supabaseConfig.url}/auth/v1/logout`,
                        {
                            method: "POST",
                            headers: {
                                "apikey":
                                    supabaseConfig.publishableKey,
                                "Authorization":
                                    `Bearer ${accessToken}`
                            }
                        }
                    );
                } catch (error) {
                    console.warn(
                        "Cloud logout request failed:",
                        error
                    );
                }
            }

            sessionStorage.clear();
            clearCloudSession();
            clearCart();
            showLogin();

            document.dispatchEvent(
                new CustomEvent("user-role-changed")
            );
        }
    );

    const savedLogin =
        sessionStorage.getItem("merchTillLoggedIn");

    const savedUsername =
        sessionStorage.getItem("merchTillUsername");

    if (savedLogin === "true" && savedUsername) {
        dom.loginScreen.hidden = true;
        dom.appScreen.hidden = false;
        dom.loggedInUser.textContent =
            savedUsername;
    } else {
        showLogin();
    }
}
