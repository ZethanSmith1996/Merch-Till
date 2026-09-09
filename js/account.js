import { dom } from "./dom.js?v=stage23";
import { supabaseConfig } from "./config.js?v=stage23";
import {
    getValidCloudAccessToken,
    isCloudUsername
} from "./auth.js?v=step1e";
import {
    logAuditEvent,
    auditActorUsername
} from "./audit-log.js?v=stage15f";
import {
    cacheDiscountAuthorisers,
    getCachedDiscountAuthorisers
} from "./discount-cache.js?v=stage23-1";


const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    manager: "Manager",
    staff: "Staff",
    training: "Training"
};

let currentCloudAccountInfo = null;


function currentUsername() {
    return (
        sessionStorage.getItem(
            "merchTillUsername"
        ) || ""
    );
}


function currentRole() {
    return (
        sessionStorage.getItem(
            "merchTillRole"
        ) || ""
    );
}


function accountRole() {
    return (
        currentCloudAccountInfo?.role ||
        currentRole()
    );
}


function canHaveDiscountPin() {
    return [
        "master-admin",
        "admin",
        "manager"
    ].includes(
        accountRole()
    );
}


function setAccountStatus(
    message,
    isError = false
) {
    if (!dom.myAccountStatus) {
        return;
    }

    dom.myAccountStatus.textContent =
        message;

    dom.myAccountStatus.classList.toggle(
        "cloud-upload-error",
        isError
    );
}


async function accountRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "This account change requires an internet connection."
        );
    }

    const token =
        await getValidCloudAccessToken();

    if (!token) {
        throw new Error(
            "No valid cloud session is available. Log out and log back in while online."
        );
    }

    const response =
        await fetch(
            `${supabaseConfig.url}/${path}`,
            {
                ...options,
                headers: {
                    "apikey":
                        supabaseConfig
                            .publishableKey,
                    "Authorization":
                        `Bearer ${token}`,
                    ...(options.headers || {})
                }
            }
        );

    const text =
        await response.text();

    let data = null;

    if (text) {
        try {
            data =
                JSON.parse(text);
        } catch (error) {
            data = text;
        }
    }

    if (!response.ok) {
        throw new Error(
            data?.message ||
            data?.error_description ||
            data?.error ||
            (
                typeof data ===
                "string"
                    ? data
                    : ""
            ) ||
            `Account request failed (${response.status}).`
        );
    }

    return data;
}








export async function refreshDiscountAuthorisers({
    silent = false
} = {}) {
    const username =
        currentUsername();

    if (
        !username ||
        !isCloudUsername(username) ||
        !navigator.onLine
    ) {
        return getCachedDiscountAuthorisers();
    }

    try {
        const rows =
            await accountRequest(
                "rest/v1/rpc/get_discount_authorisers",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json",
                        "Accept":
                            "application/json"
                    },
                    body:
                        "{}"
                }
            );

        const safeRows =
            Array.isArray(rows)
                ? rows
                : [];

        cacheDiscountAuthorisers(
            safeRows
        );

        return getCachedDiscountAuthorisers();

    } catch (error) {
        if (!silent) {
            console.warn(
                "Discount authorisers could not be refreshed:",
                error
            );
        }

        return getCachedDiscountAuthorisers();
    }
}





async function loadMyAccountInfo() {
    const username =
        currentUsername();

    if (
        !username ||
        !isCloudUsername(username) ||
        !navigator.onLine
    ) {
        currentCloudAccountInfo =
            null;

        return null;
    }

    const rows =
        await accountRequest(
            "rest/v1/rpc/get_my_account_info",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    "{}"
            }
        );

    const info =
        Array.isArray(rows)
            ? rows[0]
            : rows;

    if (!info) {
        currentCloudAccountInfo =
            null;

        return null;
    }

    currentCloudAccountInfo = {
        username:
            info.username ||
            username,
        role:
            info.role ||
            currentRole(),
        hasDiscountPin:
            Boolean(
                info.has_discount_pin
            )
    };

    /*
     * Keep the local session's role aligned with the authoritative profile.
     * This matters when Master promotes a user while that user's device is
     * already signed in.
     */
    if (
        currentCloudAccountInfo.role
    ) {
        sessionStorage.setItem(
            "merchTillRole",
            currentCloudAccountInfo.role
        );
    }

    return currentCloudAccountInfo;
}


function updateDiscountPinWording() {
    if (
        !dom.myAccountDiscountCard
    ) {
        return;
    }

    const hasPin =
        Boolean(
            currentCloudAccountInfo
                ?.hasDiscountPin
        );

    const heading =
        dom.myAccountDiscountCard
            .querySelector("h3");

    const copy =
        dom.myAccountDiscountCard
            .querySelector(
                ".my-account-card-heading p"
            );

    const submit =
        dom.myAccountDiscountForm
            ?.querySelector(
                'button[type="submit"]'
            );

    if (heading) {
        heading.textContent =
            hasPin
                ? "Discount Code"
                : "Set Discount Code";
    }

    if (copy) {
        copy.textContent =
            hasPin
                ? "Change the PIN you use to authorise discounts at the Till."
                : "Create your first PIN for authorising discounts at the Till.";
    }

    if (submit) {
        submit.textContent =
            hasPin
                ? "Change Discount PIN"
                : "Set Discount PIN";
    }
}


function renderAccountIdentity() {
    const username =
        currentUsername();

    const role =
        accountRole();

    if (dom.myAccountUsername) {
        dom.myAccountUsername.textContent =
            username || "—";
    }

    if (dom.myAccountRole) {
        dom.myAccountRole.textContent =
            roleLabels[role] ||
            role ||
            "—";
    }

    if (dom.myAccountSummary) {
        dom.myAccountSummary.textContent =
            username
                ? `Signed in as ${username}`
                : "Account settings";
    }

    const training =
        !isCloudUsername(
            username
        );

    if (
        dom.myAccountCloudSettings
    ) {
        dom.myAccountCloudSettings.hidden =
            training;
    }

    if (
        dom.myAccountTrainingMessage
    ) {
        dom.myAccountTrainingMessage.hidden =
            !training;
    }

    if (
        dom.myAccountDiscountCard
    ) {
        dom.myAccountDiscountCard.hidden =
            training ||
            !canHaveDiscountPin();
    }

    updateDiscountPinWording();
}


function resetAccountForms() {
    dom.myAccountPasswordForm
        ?.reset();

    dom.myAccountDiscountForm
        ?.reset();

    if (
        dom.myAccountPasswordError
    ) {
        dom.myAccountPasswordError
            .textContent =
            "";
    }

    if (
        dom.myAccountDiscountError
    ) {
        dom.myAccountDiscountError
            .textContent =
            "";
    }

    setAccountStatus("");
}


async function openMyAccount() {
    resetAccountForms();

    if (
        dom.myAccountModal
    ) {
        dom.myAccountModal.hidden =
            false;
    }

    renderAccountIdentity();

    try {
        await loadMyAccountInfo();

        renderAccountIdentity();

    } catch (error) {
        console.warn(
            "My Account profile could not be refreshed:",
            error
        );
    }
}


function closeMyAccount() {
    if (
        dom.myAccountModal
    ) {
        dom.myAccountModal.hidden =
            true;
    }

    resetAccountForms();
}


async function submitOwnPasswordChange(
    event
) {
    event.preventDefault();

    if (
        !isCloudUsername(
            currentUsername()
        )
    ) {
        return;
    }

    const password =
        dom.myAccountNewPassword
            ?.value || "";

    const confirmation =
        dom.myAccountConfirmPassword
            ?.value || "";

    dom.myAccountPasswordError.textContent =
        "";

    if (password.length < 8) {
        dom.myAccountPasswordError.textContent =
            "Password must contain at least 8 characters.";
        return;
    }

    if (
        password !==
        confirmation
    ) {
        dom.myAccountPasswordError.textContent =
            "The passwords do not match.";
        return;
    }

    const submit =
        dom.myAccountPasswordForm
            ?.querySelector(
                'button[type="submit"]'
            );

    if (submit) {
        submit.disabled = true;
        submit.textContent =
            "Changing Password…";
    }

    try {
        await accountRequest(
            "auth/v1/user",
            {
                method: "PUT",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body:
                    JSON.stringify({
                        password
                    })
            }
        );

        dom.myAccountPasswordForm.reset();

        setAccountStatus(
            "Password changed successfully."
        );

        await logAuditEvent(
            "user_management",
            `${auditActorUsername()} changed their own password.`,
            {
                action:
                    "self_password_changed"
            },
            `self-password-change:${currentUsername()}:${Date.now()}`
        );

    } catch (error) {
        dom.myAccountPasswordError.textContent =
            error instanceof Error
                ? error.message
                : String(error);

    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent =
                "Change Password";
        }
    }
}


async function submitOwnDiscountPin(
    event
) {
    event.preventDefault();

    if (!canHaveDiscountPin()) {
        return;
    }

    const pin =
        dom.myAccountDiscountPin
            ?.value.trim() ||
        "";

    const confirmation =
        dom.myAccountConfirmDiscountPin
            ?.value.trim() ||
        "";

    dom.myAccountDiscountError.textContent =
        "";

    if (
        !/^[0-9]{4,8}$/.test(
            pin
        )
    ) {
        dom.myAccountDiscountError.textContent =
            "Discount PIN must contain 4–8 digits.";
        return;
    }

    if (
        pin !==
        confirmation
    ) {
        dom.myAccountDiscountError.textContent =
            "The discount PINs do not match.";
        return;
    }

    const submit =
        dom.myAccountDiscountForm
            ?.querySelector(
                'button[type="submit"]'
            );

    if (submit) {
        submit.disabled = true;
        submit.textContent =
            "Changing PIN…";
    }

    try {
        await accountRequest(
            "rest/v1/rpc/set_my_discount_pin",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    JSON.stringify({
                        p_pin:
                            pin
                    })
            }
        );

        await refreshDiscountAuthorisers({
            silent: true
        });

        if (
            currentCloudAccountInfo
        ) {
            currentCloudAccountInfo
                .hasDiscountPin =
                true;
        }

        updateDiscountPinWording();

        dom.myAccountDiscountForm.reset();

        setAccountStatus(
            "Discount PIN saved successfully."
        );

    } catch (error) {
        dom.myAccountDiscountError.textContent =
            error instanceof Error
                ? error.message
                : String(error);

    } finally {
        if (submit) {
            submit.disabled = false;
        }

        updateDiscountPinWording();
    }
}


export function initialiseAccount() {
    dom.loggedInUser
        ?.addEventListener(
            "click",
            openMyAccount
        );

    dom.closeMyAccountModalButton
        ?.addEventListener(
            "click",
            closeMyAccount
        );

    dom.myAccountModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.myAccountModal
                ) {
                    closeMyAccount();
                }
            }
        );

    dom.myAccountPasswordForm
        ?.addEventListener(
            "submit",
            submitOwnPasswordChange
        );

    dom.myAccountDiscountForm
        ?.addEventListener(
            "submit",
            submitOwnDiscountPin
        );

    document.addEventListener(
        "keydown",
        function (event) {
            if (
                event.key ===
                    "Escape" &&
                dom.myAccountModal &&
                !dom.myAccountModal.hidden
            ) {
                closeMyAccount();
            }
        }
    );

    document.addEventListener(
        "user-role-changed",
        async function () {
            if (
                sessionStorage.getItem(
                    "merchTillLoggedIn"
                ) === "true"
            ) {
                try {
                    await loadMyAccountInfo();
                } catch (error) {
                    // Session role remains the fallback if offline/unavailable.
                }

                renderAccountIdentity();

                refreshDiscountAuthorisers({
                    silent: true
                });
            }
        }
    );

    window.addEventListener(
        "online",
        function () {
            refreshDiscountAuthorisers({
                silent: true
            });
        }
    );
}
