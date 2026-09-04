import { dom } from "./dom.js";
import { supabaseConfig } from "./config.js";
import {
    getValidCloudAccessToken,
    isCloudUsername
} from "./auth.js?v=step1e";
import { canManageOptions } from "./permissions.js";

const OPTIONS_CACHE_KEY =
    "merchTillOptionsCacheV1";

const optionState = {
    paymentTypesEnabled: false,
    loadedFromCloud: false
};

let refreshInProgress = false;
let saveInProgress = false;
let visibleRefreshTimer = null;


function currentUsername() {
    return (
        sessionStorage.getItem(
            "merchTillUsername"
        ) || ""
    );
}


function readCachedOptions() {
    try {
        const saved =
            JSON.parse(
                localStorage.getItem(
                    OPTIONS_CACHE_KEY
                ) || "{}"
            );

        if (
            typeof saved
                .paymentTypesEnabled ===
            "boolean"
        ) {
            optionState
                .paymentTypesEnabled =
                saved.paymentTypesEnabled;
        }
    } catch (error) {
        console.warn(
            "Options cache could not be read:",
            error
        );
    }
}


function writeCachedOptions() {
    localStorage.setItem(
        OPTIONS_CACHE_KEY,
        JSON.stringify({
            paymentTypesEnabled:
                optionState
                    .paymentTypesEnabled
        })
    );
}


function setOptionsStatus(
    message,
    isError = false
) {
    if (!dom.optionsStatus) {
        return;
    }

    dom.optionsStatus.textContent =
        message;

    dom.optionsStatus.classList.toggle(
        "options-error",
        isError
    );
}


function renderOptions() {
    if (dom.paymentTypesOption) {
        dom.paymentTypesOption.checked =
            optionState
                .paymentTypesEnabled;

        dom.paymentTypesOption.disabled =
            saveInProgress ||
            refreshInProgress ||
            !navigator.onLine;
    }

    if (
        dom.paymentTypesOptionLabel
    ) {
        dom.paymentTypesOptionLabel
            .textContent =
            optionState
                .paymentTypesEnabled
                    ? "On"
                    : "Off";
    }
}


async function settingsRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "Options can only be changed while online."
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
            `${supabaseConfig.url}/rest/v1/${path}`,
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

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Options request failed (${response.status}). ${details}`
        );
    }

    return response;
}


function applyCloudRows(rows) {
    const settings =
        Array.isArray(rows)
            ? rows
            : [];

    const paymentSetting =
        settings.find(
            function (setting) {
                return (
                    setting.setting_key ===
                    "payment_types_enabled"
                );
            }
        );

    if (paymentSetting) {
        optionState
            .paymentTypesEnabled =
            paymentSetting.value === true;
    }

    optionState.loadedFromCloud =
        true;

    writeCachedOptions();
    renderOptions();

    document.dispatchEvent(
        new CustomEvent(
            "options-changed",
            {
                detail: {
                    paymentTypesEnabled:
                        optionState
                            .paymentTypesEnabled
                }
            }
        )
    );
}


export async function refreshOptionsFromCloud(
    {
        silent = false
    } = {}
) {
    const username =
        currentUsername();

    if (
        !isCloudUsername(username)
    ) {
        renderOptions();
        return false;
    }

    if (!navigator.onLine) {
        renderOptions();

        if (!silent) {
            setOptionsStatus(
                "Offline — showing the last settings saved on this device.",
                true
            );
        }

        return false;
    }

    if (refreshInProgress) {
        return false;
    }

    refreshInProgress = true;
    renderOptions();

    if (!silent) {
        setOptionsStatus(
            "Loading options…"
        );
    }

    try {
        const response =
            await settingsRequest(
                "rpc/get_app_settings",
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
                            p_scope_type:
                                "global",
                            p_scope_id:
                                null
                        })
                }
            );

        const rows =
            await response.json();

        applyCloudRows(rows);

        if (!silent) {
            setOptionsStatus(
                "Options are up to date."
            );
        }

        return true;

    } catch (error) {
        console.warn(
            "Options could not be loaded:",
            error
        );

        renderOptions();

        if (!silent) {
            setOptionsStatus(
                error instanceof Error
                    ? error.message
                    : String(error),
                true
            );
        }

        return false;

    } finally {
        refreshInProgress =
            false;

        renderOptions();
    }
}


async function setGlobalOption(
    settingKey,
    value
) {
    if (!canManageOptions()) {
        throw new Error(
            "You do not have permission to change Options."
        );
    }

    const response =
        await settingsRequest(
            "rpc/set_app_setting",
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
                        p_setting_key:
                            settingKey,
                        p_value:
                            value,
                        p_scope_type:
                            "global",
                        p_scope_id:
                            null
                    })
            }
        );

    return response.json();
}


async function changePaymentTypes() {
    if (
        !dom.paymentTypesOption
    ) {
        return;
    }

    const requestedValue =
        dom.paymentTypesOption.checked;

    const previousValue =
        optionState
            .paymentTypesEnabled;

    if (!navigator.onLine) {
        dom.paymentTypesOption.checked =
            previousValue;

        renderOptions();

        setOptionsStatus(
            "Options cannot be changed while offline.",
            true
        );

        return;
    }

    saveInProgress = true;
    renderOptions();

    setOptionsStatus(
        requestedValue
            ? "Turning Payment Types on…"
            : "Turning Payment Types off…"
    );

    try {
        const result =
            await setGlobalOption(
                "payment_types_enabled",
                requestedValue
            );

        optionState
            .paymentTypesEnabled =
            result?.value === true;

        optionState.loadedFromCloud =
            true;

        writeCachedOptions();
        renderOptions();

        setOptionsStatus(
            optionState
                .paymentTypesEnabled
                ? "Payment Types is on."
                : "Payment Types is off."
        );

        document.dispatchEvent(
            new CustomEvent(
                "options-changed",
                {
                    detail: {
                        paymentTypesEnabled:
                            optionState
                                .paymentTypesEnabled
                    }
                }
            )
        );

        document.dispatchEvent(
            new CustomEvent(
                "audit-log-updated"
            )
        );

    } catch (error) {
        optionState
            .paymentTypesEnabled =
            previousValue;

        writeCachedOptions();
        renderOptions();

        setOptionsStatus(
            error instanceof Error
                ? error.message
                : String(error),
            true
        );

    } finally {
        saveInProgress = false;
        renderOptions();
    }
}


function startVisibleRefresh() {
    stopVisibleRefresh();

    visibleRefreshTimer =
        window.setInterval(
            function () {
                if (
                    dom.optionsSection &&
                    !dom.optionsSection.hidden &&
                    navigator.onLine
                ) {
                    refreshOptionsFromCloud({
                        silent: true
                    });
                }
            },
            5000
        );
}


function stopVisibleRefresh() {
    if (
        visibleRefreshTimer !== null
    ) {
        window.clearInterval(
            visibleRefreshTimer
        );

        visibleRefreshTimer = null;
    }
}


export function isPaymentTypesEnabled() {
    return optionState
        .paymentTypesEnabled;
}


export function initialiseOptions() {
    readCachedOptions();
    renderOptions();

    if (dom.paymentTypesOption) {
        dom.paymentTypesOption
            .addEventListener(
                "change",
                changePaymentTypes
            );
    }

    if (dom.optionsNavButton) {
        dom.optionsNavButton
            .addEventListener(
                "click",
                function () {
                    refreshOptionsFromCloud();
                    startVisibleRefresh();
                }
            );
    }

    window.addEventListener(
        "offline",
        function () {
            renderOptions();

            if (
                dom.optionsSection &&
                !dom.optionsSection.hidden
            ) {
                setOptionsStatus(
                    "Offline — showing the last settings saved on this device.",
                    true
                );
            }
        }
    );

    window.addEventListener(
        "online",
        function () {
            if (
                dom.optionsSection &&
                !dom.optionsSection.hidden
            ) {
                refreshOptionsFromCloud();
            }
        }
    );

    document.addEventListener(
        "user-role-changed",
        renderOptions
    );

    /*
     * Stop the Options-specific polling when navigating away. The global
     * cloud-sync system remains untouched.
     */
    document
        .querySelectorAll(
            ".nav-button"
        )
        .forEach(
            function (button) {
                if (
                    button !==
                    dom.optionsNavButton
                ) {
                    button.addEventListener(
                        "click",
                        stopVisibleRefresh
                    );
                }
            }
        );
}
