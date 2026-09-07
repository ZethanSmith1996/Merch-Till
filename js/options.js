import { dom } from "./dom.js";
import { supabaseConfig } from "./config.js";
import {
    getValidCloudAccessToken,
    isCloudUsername
} from "./auth.js?v=step1e";
import {
    canManageOptions
} from "./permissions.js?v=stage15b";
import { escapeHTML } from "./utils.js";


const OPTIONS_CACHE_KEY =
    "merchTillOptionsCache";

const SELECTED_DEPARTMENT_KEY =
    "merchTillSelectedDepartment";


const optionState = {
    departmentsEnabled: false,
    paymentTypesEnabled: false,
    departmentPaymentTypes: {},
    departments: [],
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


function currentDepartmentId() {
    try {
        const department =
            JSON.parse(
                sessionStorage.getItem(
                    SELECTED_DEPARTMENT_KEY
                ) || "null"
            );

        if (
            department &&
            Number.isFinite(
                Number(department.id)
            )
        ) {
            return Number(
                department.id
            );
        }
    } catch (error) {
        // Use Merchandise fallback.
    }

    return 1;
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
        "cloud-upload-error",
        isError
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
                .departmentsEnabled ===
            "boolean"
        ) {
            optionState
                .departmentsEnabled =
                saved.departmentsEnabled;
        }

        if (
            typeof saved
                .paymentTypesEnabled ===
            "boolean"
        ) {
            optionState
                .paymentTypesEnabled =
                saved.paymentTypesEnabled;
        }

        if (
            saved.departmentPaymentTypes &&
            typeof saved.departmentPaymentTypes ===
                "object"
        ) {
            optionState
                .departmentPaymentTypes =
                {
                    ...saved
                        .departmentPaymentTypes
                };
        }

        if (
            Array.isArray(
                saved.departments
            )
        ) {
            optionState.departments =
                saved.departments;
        }

    } catch (error) {
        console.warn(
            "Cached Options could not be read:",
            error
        );
    }
}


function writeCachedOptions() {
    localStorage.setItem(
        OPTIONS_CACHE_KEY,
        JSON.stringify({
            departmentsEnabled:
                optionState
                    .departmentsEnabled,
            paymentTypesEnabled:
                optionState
                    .paymentTypesEnabled,
            departmentPaymentTypes:
                optionState
                    .departmentPaymentTypes,
            departments:
                optionState
                    .departments
        })
    );
}


function normaliseDepartment(row) {
    return {
        id:
            Number(row.id),
        name:
            row.name ||
            "Department",
        active:
            row.active !== false,
        isMerchandise:
            row.is_merchandise === true ||
            row.isMerchandise === true,
        badgeColor:
            row.badge_color ||
            row.badgeColor ||
            "default"
    };
}


function paymentEnabledForDepartment(
    departmentId
) {
    const key =
        String(
            departmentId || 1
        );

    if (
        Object.prototype
            .hasOwnProperty
            .call(
                optionState
                    .departmentPaymentTypes,
                key
            )
    ) {
        return (
            optionState
                .departmentPaymentTypes[
                    key
                ] === true
        );
    }

    /*
     * A Department with no explicit setting inherits the legacy/global
     * Payment Types value. This means newly-created Departments behave
     * predictably until Master chooses a Department-specific value.
     */
    return optionState
        .paymentTypesEnabled;
}


function renderDepartmentPaymentRows() {
    if (
        !dom.departmentPaymentTypesOptions
    ) {
        return;
    }

    dom.departmentPaymentTypesOptions
        .innerHTML = "";

    optionState
        .departments
        .forEach(
            function (department) {
                const enabled =
                    paymentEnabledForDepartment(
                        department.id
                    );

                const row =
                    document.createElement(
                        "div"
                    );

                row.className =
                    "department-option-row";

                row.innerHTML = `
                    <div class="department-option-copy">
                        <strong>
                            ${escapeHTML(department.name)}
                        </strong>

                        <small>
                            ${
                                department.active
                                    ? "Active Department"
                                    : "Disabled Department"
                            }
                        </small>
                    </div>

                    <label
                        class="option-switch"
                        aria-label="${escapeHTML(department.name)} Payment Types"
                    >
                        <input
                            type="checkbox"
                            data-department-payment-option="${department.id}"
                            ${enabled ? "checked" : ""}
                        >

                        <span
                            class="option-switch-track"
                            aria-hidden="true"
                        >
                            <span class="option-switch-thumb"></span>
                        </span>

                        <span class="option-switch-label">
                            ${enabled ? "On" : "Off"}
                        </span>
                    </label>
                `;

                const input =
                    row.querySelector(
                        "[data-department-payment-option]"
                    );

                input.disabled =
                    saveInProgress ||
                    refreshInProgress ||
                    !navigator.onLine;

                input.addEventListener(
                    "change",
                    function () {
                        changeDepartmentPaymentTypes(
                            department,
                            input
                        );
                    }
                );

                dom
                    .departmentPaymentTypesOptions
                    .appendChild(
                        row
                    );
            }
        );

    if (
        optionState.departments.length ===
        0
    ) {
        dom.departmentPaymentTypesOptions
            .innerHTML =
            '<p class="department-options-empty">No Departments are configured.</p>';
    }
}


function renderOptions() {
    if (
        dom.departmentsEnabledOption
    ) {
        dom.departmentsEnabledOption.checked =
            optionState
                .departmentsEnabled;

        dom.departmentsEnabledOption.disabled =
            saveInProgress ||
            refreshInProgress ||
            !navigator.onLine;
    }

    if (
        dom.departmentsEnabledOptionLabel
    ) {
        dom.departmentsEnabledOptionLabel
            .textContent =
            optionState
                .departmentsEnabled
                    ? "On"
                    : "Off";
    }

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

    if (
        dom.checkoutOptionsScopeBadge
    ) {
        dom.checkoutOptionsScopeBadge
            .textContent =
            optionState
                .departmentsEnabled
                    ? "Per Department"
                    : "Global";
    }

    if (
        dom.globalPaymentTypesOptionRow
    ) {
        dom.globalPaymentTypesOptionRow
            .hidden =
            optionState
                .departmentsEnabled;
    }

    if (
        dom.departmentPaymentTypesOptions
    ) {
        dom.departmentPaymentTypesOptions
            .hidden =
            !optionState
                .departmentsEnabled;
    }

    if (
        optionState
            .departmentsEnabled
    ) {
        renderDepartmentPaymentRows();
    }
}


async function settingsRequest(
    path,
    options = {}
) {
    if (!navigator.onLine) {
        throw new Error(
            "Options requires an internet connection."
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


async function rpcSettings(
    scopeType,
    scopeId = null
) {
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
                            scopeType,
                        p_scope_id:
                            scopeId
                    })
            }
        );

    return response.json();
}


async function fetchDepartmentsForOptions() {
    const includeDisabled =
        canManageOptions();

    const response =
        await settingsRequest(
            "rpc/get_departments",
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
                        p_include_disabled:
                            includeDisabled
                    })
            }
        );

    const rows =
        await response.json();

    return Array.isArray(rows)
        ? rows.map(
            normaliseDepartment
        )
        : [];
}


function applyGlobalRows(rows) {
    const departmentsSetting =
        rows.find(
            function (setting) {
                return (
                    setting.setting_key ===
                    "departments_enabled"
                );
            }
        );

    const paymentSetting =
        rows.find(
            function (setting) {
                return (
                    setting.setting_key ===
                    "payment_types_enabled"
                );
            }
        );

    if (departmentsSetting) {
        optionState
            .departmentsEnabled =
            departmentsSetting.value ===
            true;
    }

    if (paymentSetting) {
        optionState
            .paymentTypesEnabled =
            paymentSetting.value ===
            true;
    }
}


async function loadDepartmentPaymentSettings(
    departments
) {
    const result = {};

    await Promise.all(
        departments.map(
            async function (
                department
            ) {
                try {
                    const rows =
                        await rpcSettings(
                            "department",
                            String(
                                department.id
                            )
                        );

                    const setting =
                        rows.find(
                            function (row) {
                                return (
                                    row.setting_key ===
                                    "payment_types_enabled"
                                );
                            }
                        );

                    if (setting) {
                        result[
                            String(
                                department.id
                            )
                        ] =
                            setting.value ===
                            true;
                    }
                } catch (error) {
                    console.warn(
                        `Department option could not be loaded for ${department.name}:`,
                        error
                    );
                }
            }
        )
    );

    optionState
        .departmentPaymentTypes =
        result;
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
        const globalRows =
            await rpcSettings(
                "global",
                null
            );

        applyGlobalRows(
            globalRows
        );

        const departments =
            await fetchDepartmentsForOptions();

        optionState.departments =
            departments;

        await loadDepartmentPaymentSettings(
            departments
        );

        optionState.loadedFromCloud =
            true;

        writeCachedOptions();

        document.dispatchEvent(
            new CustomEvent(
                "options-changed",
                {
                    detail: {
                        departmentsEnabled:
                            optionState
                                .departmentsEnabled,
                        paymentTypesEnabled:
                            isPaymentTypesEnabled()
                    }
                }
            )
        );

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


async function setOption(
    settingKey,
    value,
    scopeType,
    scopeId
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
                            scopeType,
                        p_scope_id:
                            scopeId
                    })
            }
        );

    return response.json();
}


async function setGlobalOption(
    settingKey,
    value
) {
    return setOption(
        settingKey,
        value,
        "global",
        null
    );
}


async function changeDepartmentsEnabled() {
    if (
        !dom.departmentsEnabledOption
    ) {
        return;
    }

    const requestedValue =
        dom.departmentsEnabledOption
            .checked;

    const previousValue =
        optionState
            .departmentsEnabled;

    if (!navigator.onLine) {
        dom.departmentsEnabledOption.checked =
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

    try {
        const result =
            await setGlobalOption(
                "departments_enabled",
                requestedValue
            );

        optionState
            .departmentsEnabled =
            result?.value === true;

        /*
         * When Departments is first switched on, a Department with no
         * explicit Payment Types setting inherits the current global value.
         * We do not need to manufacture rows simply to preserve behaviour.
         */
        writeCachedOptions();
        renderOptions();

        setOptionsStatus(
            optionState
                .departmentsEnabled
                ? "Departments is on. Checkout Options are now set per Department."
                : "Departments is off. Checkout Options use the single global Merchandise setting."
        );

        document.dispatchEvent(
            new CustomEvent(
                "options-changed",
                {
                    detail: {
                        departmentsEnabled:
                            optionState
                                .departmentsEnabled,
                        paymentTypesEnabled:
                            isPaymentTypesEnabled()
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
            .departmentsEnabled =
            previousValue;

        writeCachedOptions();

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

    try {
        const result =
            await setGlobalOption(
                "payment_types_enabled",
                requestedValue
            );

        optionState
            .paymentTypesEnabled =
            result?.value === true;

        writeCachedOptions();

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
                        departmentsEnabled:
                            optionState
                                .departmentsEnabled,
                        paymentTypesEnabled:
                            isPaymentTypesEnabled()
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


async function changeDepartmentPaymentTypes(
    department,
    input
) {
    const key =
        String(
            department.id
        );

    const requestedValue =
        input.checked;

    const previousValue =
        paymentEnabledForDepartment(
            department.id
        );

    if (!navigator.onLine) {
        input.checked =
            previousValue;
        renderOptions();
        return;
    }

    saveInProgress = true;
    renderOptions();

    try {
        const result =
            await setOption(
                "payment_types_enabled",
                requestedValue,
                "department",
                key
            );

        optionState
            .departmentPaymentTypes[
                key
            ] =
            result?.value === true;

        writeCachedOptions();

        setOptionsStatus(
            `Payment Types for ${department.name} is ${requestedValue ? "on" : "off"}.`
        );

        document.dispatchEvent(
            new CustomEvent(
                "options-changed",
                {
                    detail: {
                        departmentsEnabled:
                            optionState
                                .departmentsEnabled,
                        departmentId:
                            department.id,
                        paymentTypesEnabled:
                            isPaymentTypesEnabled()
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
        input.checked =
            previousValue;

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


export function isDepartmentsEnabled() {
    return optionState
        .departmentsEnabled;
}


export function isPaymentTypesEnabled() {
    if (
        !optionState
            .departmentsEnabled
    ) {
        return optionState
            .paymentTypesEnabled;
    }

    return paymentEnabledForDepartment(
        currentDepartmentId()
    );
}


export function initialiseOptions() {
    readCachedOptions();
    renderOptions();

    dom.departmentsEnabledOption
        ?.addEventListener(
            "change",
            changeDepartmentsEnabled
        );

    dom.paymentTypesOption
        ?.addEventListener(
            "change",
            changePaymentTypes
        );

    dom.optionsNavButton
        ?.addEventListener(
            "click",
            function () {
                refreshOptionsFromCloud();
                startVisibleRefresh();
            }
        );

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
            refreshOptionsFromCloud({
                silent: true
            });

            if (
                dom.optionsSection &&
                !dom.optionsSection.hidden
            ) {
                startVisibleRefresh();
            }
        }
    );

    document.addEventListener(
        "user-role-changed",
        renderOptions
    );

    document.addEventListener(
        "department-context-changed",
        function () {
            document.dispatchEvent(
                new CustomEvent(
                    "options-changed",
                    {
                        detail: {
                            departmentsEnabled:
                                optionState
                                    .departmentsEnabled,
                            paymentTypesEnabled:
                                isPaymentTypesEnabled()
                        }
                    }
                )
            );
        }
    );

    document.addEventListener(
        "departments-changed",
        function () {
            if (
                navigator.onLine
            ) {
                refreshOptionsFromCloud({
                    silent: true
                });
            }
        }
    );

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
