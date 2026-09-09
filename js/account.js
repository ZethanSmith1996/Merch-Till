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


const DISCOUNT_AUTHORISERS_CACHE_KEY =
    "merchTillDiscountAuthorisersV23";


const roleLabels = {
    "master-admin": "Master Admin",
    admin: "Admin",
    manager: "Manager",
    staff: "Staff",
    training: "Training"
};


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


function canHaveDiscountPin() {
    return [
        "master-admin",
        "admin",
        "manager"
    ].includes(
        currentRole()
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


async function sha256Hex(
    value
) {
    const encoded =
        new TextEncoder()
            .encode(
                String(value)
            );

    const digest =
        await crypto.subtle.digest(
            "SHA-256",
            encoded
        );

    return Array.from(
        new Uint8Array(
            digest
        )
    )
        .map(
            function (byte) {
                return byte
                    .toString(16)
                    .padStart(2, "0");
            }
        )
        .join("");
}


function readCachedDiscountAuthorisers() {
    try {
        const parsed =
            JSON.parse(
                localStorage.getItem(
                    DISCOUNT_AUTHORISERS_CACHE_KEY
                ) || "[]"
            );

        return Array.isArray(parsed)
            ? parsed
            : [];

    } catch (error) {
        return [];
    }
}


function cacheDiscountAuthorisers(
    rows
) {
    localStorage.setItem(
        DISCOUNT_AUTHORISERS_CACHE_KEY,
        JSON.stringify(
            rows.map(
                function (row) {
                    return {
                        username:
                            row.username,
                        pinHash:
                            row.pin_hash
                    };
                }
            )
        )
    );
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
        return readCachedDiscountAuthorisers();
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

        return readCachedDiscountAuthorisers();

    } catch (error) {
        if (!silent) {
            console.warn(
                "Discount authorisers could not be refreshed:",
                error
            );
        }

        return readCachedDiscountAuthorisers();
    }
}


export async function validateDiscountPin(
    pin
) {
    let authorisers =
        readCachedDiscountAuthorisers();

    if (navigator.onLine) {
        authorisers =
            await refreshDiscountAuthorisers({
                silent: true
            });
    }

    if (
        authorisers.length === 0
    ) {
        throw new Error(
            navigator.onLine
                ? "Discount authorisation is not currently available."
                : "Discount codes have not yet been synchronised to this device. Reconnect once before using discounts offline."
        );
    }

    const hash =
        await sha256Hex(
            String(pin || "")
        );

    return (
        authorisers.find(
            function (
                authoriser
            ) {
                return (
                    authoriser.pinHash ===
                    hash
                );
            }
        ) || null
    );
}


function renderAccountIdentity() {
    const username =
        currentUsername();

    const role =
        currentRole();

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


function openMyAccount() {
    resetAccountForms();
    renderAccountIdentity();

    if (
        dom.myAccountModal
    ) {
        dom.myAccountModal.hidden =
            false;
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

        dom.myAccountDiscountForm.reset();

        setAccountStatus(
            "Discount PIN changed successfully."
        );

    } catch (error) {
        dom.myAccountDiscountError.textContent =
            error instanceof Error
                ? error.message
                : String(error);

    } finally {
        if (submit) {
            submit.disabled = false;
            submit.textContent =
                "Change Discount PIN";
        }
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
        function () {
            renderAccountIdentity();

            if (
                sessionStorage.getItem(
                    "merchTillLoggedIn"
                ) === "true"
            ) {
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
