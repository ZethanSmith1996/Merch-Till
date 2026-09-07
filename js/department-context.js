import { dom } from "./dom.js";
import { supabaseConfig } from "./config.js";
import { getValidCloudAccessToken } from "./auth.js?v=step1e";
import { isDepartmentsEnabled } from "./options.js?v=stage15e";
import {
    getCurrentUserRole,
    ROLE_MASTER_ADMIN,
    ROLE_MANAGER
} from "./permissions.js?v=stage15b";
import { escapeHTML } from "./utils.js";


const ACTIVE_DEPARTMENTS_CACHE_KEY =
    "merchTillActiveDepartmentsCache";

const SELECTED_DEPARTMENT_KEY =
    "merchTillSelectedDepartment";

const UNAVAILABLE_DEPARTMENTS_KEY =
    "merchTillUnavailableDepartments";

const MERCHANDISE_DEPARTMENT = {
    id: 1,
    key: "merchandise",
    name: "Merchandise",
    active: true,
    isMerchandise: true,
    badgeColor: "default"
};


let activeDepartments = [];
let selectorResolver = null;
let selectorTargetScreen = null;


function normaliseDepartment(row) {
    return {
        id:
            Number(row.id),
        key:
            row.department_key ||
            row.key ||
            "",
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


function readCachedDepartments() {
    try {
        const saved =
            JSON.parse(
                localStorage.getItem(
                    ACTIVE_DEPARTMENTS_CACHE_KEY
                ) || "[]"
            );

        return Array.isArray(saved)
            ? saved.map(
                normaliseDepartment
            )
            : [];
    } catch (error) {
        return [];
    }
}


function writeCachedDepartments(
    departments
) {
    localStorage.setItem(
        ACTIVE_DEPARTMENTS_CACHE_KEY,
        JSON.stringify(
            departments
        )
    );
}


function readUnavailableDepartmentIds() {
    try {
        const saved =
            JSON.parse(
                localStorage.getItem(
                    UNAVAILABLE_DEPARTMENTS_KEY
                ) || "[]"
            );

        return new Set(
            Array.isArray(saved)
                ? saved.map(
                    function (id) {
                        return String(id);
                    }
                )
                : []
        );
    } catch (error) {
        return new Set();
    }
}


function writeUnavailableDepartmentIds(
    ids
) {
    localStorage.setItem(
        UNAVAILABLE_DEPARTMENTS_KEY,
        JSON.stringify(
            Array.from(ids)
        )
    );
}


export function isDepartmentAvailableOnDevice(
    departmentId
) {
    return !readUnavailableDepartmentIds()
        .has(
            String(departmentId)
        );
}


export function setDepartmentAvailableOnDevice(
    departmentId,
    available
) {
    const ids =
        readUnavailableDepartmentIds();

    const key =
        String(departmentId);

    if (available) {
        ids.delete(key);
    } else {
        ids.add(key);
    }

    writeUnavailableDepartmentIds(
        ids
    );

    document.dispatchEvent(
        new CustomEvent(
            "device-department-availability-changed",
            {
                detail: {
                    departmentId:
                        Number(departmentId),
                    available:
                        Boolean(available)
                }
            }
        )
    );
}


function userBypassesDeviceAvailability() {
    const role =
        getCurrentUserRole();

    return (
        role === ROLE_MASTER_ADMIN ||
        role === ROLE_MANAGER
    );
}


export function filterDepartmentsForCurrentDevice(
    departments
) {
    if (
        userBypassesDeviceAvailability()
    ) {
        return departments;
    }

    return departments.filter(
        function (department) {
            return isDepartmentAvailableOnDevice(
                department.id
            );
        }
    );
}


function readSelectedDepartment() {
    try {
        const saved =
            JSON.parse(
                sessionStorage.getItem(
                    SELECTED_DEPARTMENT_KEY
                ) || "null"
            );

        if (
            saved &&
            Number.isFinite(
                Number(saved.id)
            )
        ) {
            return normaliseDepartment(
                saved
            );
        }
    } catch (error) {
        // Fall through to Merchandise.
    }

    return MERCHANDISE_DEPARTMENT;
}


function writeSelectedDepartment(
    department
) {
    sessionStorage.setItem(
        SELECTED_DEPARTMENT_KEY,
        JSON.stringify(
            department
        )
    );
}


export function getCurrentDepartment() {
    return readSelectedDepartment();
}


function updateContextBadge(
    element,
    department
) {
    if (!element) {
        return;
    }

    const colours = [
        "default",
        "blue",
        "green",
        "pink",
        "purple",
        "orange",
        "yellow"
    ];

    colours.forEach(
        function (colour) {
            element.classList.remove(
                `department-badge-${colour}`
            );
        }
    );

    if (!isDepartmentsEnabled()) {
        element.hidden = true;
        element.textContent =
            "Merchandise";
        return;
    }

    const colour =
        colours.includes(
            department?.badgeColor
        )
            ? department.badgeColor
            : "default";

    element.classList.add(
        `department-badge-${colour}`
    );

    element.hidden = false;
    element.textContent =
        department?.name ||
        "Choose Department";
}


export function renderDepartmentContext() {
    const department =
        getCurrentDepartment();

    [
        dom.tillDepartmentContext,
        dom.productsDepartmentContext,
        dom.reportsDepartmentContext,
        dom.auditDepartmentContext
    ].forEach(
        function (element) {
            updateContextBadge(
                element,
                department
            );
        }
    );
}


export function setCurrentDepartment(
    department
) {
    const normalised =
        normaliseDepartment(
            department
        );

    writeSelectedDepartment(
        normalised
    );

    renderDepartmentContext();

    document.dispatchEvent(
        new CustomEvent(
            "department-context-changed",
            {
                detail: {
                    department:
                        normalised
                }
            }
        )
    );

    return normalised;
}


export function resetDepartmentContext() {
    writeSelectedDepartment(
        MERCHANDISE_DEPARTMENT
    );

    renderDepartmentContext();
}


async function fetchActiveDepartments() {
    const token =
        await getValidCloudAccessToken();

    if (!token) {
        throw new Error(
            "No valid cloud session is available."
        );
    }

    const response =
        await fetch(
            `${supabaseConfig.url}/rest/v1/rpc/get_departments`,
            {
                method: "POST",
                headers: {
                    "apikey":
                        supabaseConfig.publishableKey,
                    "Authorization":
                        `Bearer ${token}`,
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    JSON.stringify({
                        p_include_disabled:
                            false
                    })
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Department list could not be loaded (${response.status}). ${details}`
        );
    }

    const rows =
        await response.json();

    return Array.isArray(rows)
        ? rows
            .map(
                normaliseDepartment
            )
            .filter(
                function (department) {
                    return department.active;
                }
            )
        : [];
}


async function fetchDepartmentsForHistory() {
    const token =
        await getValidCloudAccessToken();

    if (!token) {
        throw new Error(
            "No valid cloud session is available."
        );
    }

    const response =
        await fetch(
            `${supabaseConfig.url}/rest/v1/rpc/get_departments_for_history`,
            {
                method: "POST",
                headers: {
                    "apikey":
                        supabaseConfig.publishableKey,
                    "Authorization":
                        `Bearer ${token}`,
                    "Content-Type":
                        "application/json",
                    "Accept":
                        "application/json"
                },
                body:
                    "{}"
            }
        );

    if (!response.ok) {
        const details =
            await response.text();

        throw new Error(
            `Historical Departments could not be loaded (${response.status}). ${details}`
        );
    }

    const rows =
        await response.json();

    return Array.isArray(rows)
        ? rows.map(
            normaliseDepartment
        )
        : [];
}


function historicalScreen(
    screenId
) {
    return (
        screenId === "reports-section" ||
        screenId === "audit-section"
    );
}


function mayViewDisabledDepartments() {
    const role =
        getCurrentUserRole();

    return (
        role === "admin" ||
        role === ROLE_MANAGER ||
        role === ROLE_MASTER_ADMIN
    );
}


export async function refreshActiveDepartments({
    silent = false
} = {}) {
    if (!isDepartmentsEnabled()) {
        activeDepartments = [
            MERCHANDISE_DEPARTMENT
        ];

        writeCachedDepartments(
            activeDepartments
        );

        return activeDepartments;
    }

    if (navigator.onLine) {
        try {
            activeDepartments =
                await fetchActiveDepartments();

            writeCachedDepartments(
                activeDepartments
            );

            return activeDepartments;

        } catch (error) {
            if (!silent) {
                console.warn(
                    "Active Departments could not be refreshed:",
                    error
                );
            }
        }
    }

    activeDepartments =
        readCachedDepartments()
            .filter(
                function (department) {
                    return department.active;
                }
            );

    if (
        activeDepartments.length === 0
    ) {
        activeDepartments = [
            MERCHANDISE_DEPARTMENT
        ];
    }

    return activeDepartments;
}


function screenLabel(
    screenId
) {
    switch (screenId) {
        case "products-section":
            return "Products";

        case "reports-section":
            return "Reports";

        case "audit-section":
            return "Audit Log";

        default:
            return "Till";
    }
}


function closeSelector(
    result = null
) {
    if (
        dom.departmentSelectorModal
    ) {
        dom.departmentSelectorModal.hidden =
            true;
    }

    const resolver =
        selectorResolver;

    selectorResolver = null;
    selectorTargetScreen = null;

    if (resolver) {
        resolver(result);
    }
}


function renderSelectorList(
    departments,
    targetElement
) {
    if (!targetElement) {
        return;
    }

    targetElement.innerHTML =
        "";

    const current =
        getCurrentDepartment();

    departments.forEach(
        function (department) {
            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.className =
                "department-selector-button";

            if (!department.active) {
                button.classList.add(
                    "disabled-history"
                );
            }

            if (
                Number(current.id) ===
                Number(department.id)
            ) {
                button.classList.add(
                    "current"
                );
            }

            button.innerHTML = `
                <span>
                    <strong>
                        ${escapeHTML(department.name)}
                    </strong>

                    <small>
                        ${
                            department.active
                                ? (
                                    department.isMerchandise
                                        ? "Merchandise"
                                        : "Department"
                                )
                                : "Disabled Department — history only"
                        }
                    </small>
                </span>

                <span class="department-selector-arrow">
                    ›
                </span>
            `;

            button.addEventListener(
                "click",
                function () {
                    const selected =
                        setCurrentDepartment(
                            department
                        );

                    closeSelector(
                        selected
                    );
                }
            );

            targetElement
                .appendChild(
                    button
                );
        }
    );
}


function openSelector(
    screenId,
    departments,
    disabledDepartments = []
) {
    if (
        !dom.departmentSelectorModal
    ) {
        return Promise.resolve(
            null
        );
    }

    if (selectorResolver) {
        closeSelector(null);
    }

    selectorTargetScreen =
        screenId;

    dom.departmentSelectorTitle
        .textContent =
        "Select Department";

    dom.departmentSelectorCopy
        .textContent =
        `Choose the Department to open in ${screenLabel(screenId)}.`;

    dom.departmentSelectorError
        .textContent =
        "";

    renderSelectorList(
        departments,
        dom.departmentSelectorList
    );

    const showHistorical =
        historicalScreen(
            screenId
        ) &&
        disabledDepartments.length >
            0;

    if (
        dom.disabledDepartmentSelectorSection
    ) {
        dom.disabledDepartmentSelectorSection.hidden =
            !showHistorical;
    }

    if (
        dom.disabledDepartmentSelectorList
    ) {
        dom.disabledDepartmentSelectorList.hidden =
            true;

        renderSelectorList(
            disabledDepartments,
            dom.disabledDepartmentSelectorList
        );
    }

    if (
        dom.toggleDisabledDepartmentsButton
    ) {
        dom.toggleDisabledDepartmentsButton
            .textContent =
            "Show Disabled Departments";

        dom.toggleDisabledDepartmentsButton
            .setAttribute(
                "aria-expanded",
                "false"
            );
    }

    dom.departmentSelectorModal.hidden =
        false;

    return new Promise(
        function (resolve) {
            selectorResolver =
                resolve;
        }
    );
}


export async function ensureDepartmentContextForCurrentUser() {
    /*
     * The app starts on the Till screen without requiring the user to click
     * the Till navbar button. After logout/login the previous operational
     * cache can therefore belong to a different Department.
     *
     * Resolve a valid Department immediately for the newly signed-in user.
     */
    if (!isDepartmentsEnabled()) {
        return setCurrentDepartment(
            MERCHANDISE_DEPARTMENT
        );
    }

    const available =
        filterDepartmentsForCurrentDevice(
            await refreshActiveDepartments({
                silent: true
            })
        );

    if (available.length === 0) {
        resetDepartmentContext();

        return null;
    }

    const current =
        getCurrentDepartment();

    const currentStillAvailable =
        available.find(
            function (department) {
                return (
                    Number(department.id) ===
                    Number(current.id)
                );
            }
        );

    if (currentStillAvailable) {
        return setCurrentDepartment(
            currentStillAvailable
        );
    }

    /*
     * On a fixed device, this is normally the one Department enabled on
     * that browser. On a portable device with several Departments available,
     * choose the first available Department for the initial Till screen;
     * the user can still change it from Till / Products / Reports.
     */
    return setCurrentDepartment(
        available[0]
    );
}


export async function selectDepartmentForScreen(
    screenId
) {
    const departmentScreens =
        new Set([
            "till-section",
            "products-section",
            "reports-section",
            "audit-section"
        ]);

    if (
        !departmentScreens.has(
            screenId
        )
    ) {
        return getCurrentDepartment();
    }

    if (!isDepartmentsEnabled()) {
        return setCurrentDepartment(
            MERCHANDISE_DEPARTMENT
        );
    }

    const departments =
        filterDepartmentsForCurrentDevice(
            await refreshActiveDepartments()
        );

    let disabledDepartments =
        [];

    if (
        historicalScreen(screenId) &&
        mayViewDisabledDepartments() &&
        navigator.onLine
    ) {
        try {
            const allDepartments =
                await fetchDepartmentsForHistory();

            disabledDepartments =
                filterDepartmentsForCurrentDevice(
                    allDepartments.filter(
                        function (
                            department
                        ) {
                            return (
                                department.active ===
                                false
                            );
                        }
                    )
                );
        } catch (error) {
            console.warn(
                "Disabled Department history could not be loaded:",
                error
            );
        }
    }

    if (
        departments.length === 0 &&
        disabledDepartments.length === 0
    ) {
        window.alert(
            "There are no Departments available on this device."
        );

        return null;
    }

    /*
     * Reports/Audit still show the selector if disabled history exists,
     * even where only one active Department is available.
     */
    if (
        departments.length === 1 &&
        disabledDepartments.length === 0
    ) {
        return setCurrentDepartment(
            departments[0]
        );
    }

    return openSelector(
        screenId,
        departments,
        disabledDepartments
    );
}


export function initialiseDepartmentContext() {
    resetDepartmentContext();

    dom.toggleDisabledDepartmentsButton
        ?.addEventListener(
            "click",
            function () {
                if (
                    !dom.disabledDepartmentSelectorList
                ) {
                    return;
                }

                const willShow =
                    dom.disabledDepartmentSelectorList
                        .hidden;

                dom.disabledDepartmentSelectorList.hidden =
                    !willShow;

                dom.toggleDisabledDepartmentsButton
                    .textContent =
                    willShow
                        ? "Hide Disabled Departments"
                        : "Show Disabled Departments";

                dom.toggleDisabledDepartmentsButton
                    .setAttribute(
                        "aria-expanded",
                        willShow
                            ? "true"
                            : "false"
                    );
            }
        );


    dom.closeDepartmentSelectorButton
        ?.addEventListener(
            "click",
            function () {
                closeSelector(null);
            }
        );

    dom.cancelDepartmentSelectorButton
        ?.addEventListener(
            "click",
            function () {
                closeSelector(null);
            }
        );

    dom.departmentSelectorModal
        ?.addEventListener(
            "click",
            function (event) {
                if (
                    event.target ===
                    dom.departmentSelectorModal
                ) {
                    closeSelector(null);
                }
            }
        );

    document.addEventListener(
        "keydown",
        function (event) {
            if (
                event.key === "Escape" &&
                dom.departmentSelectorModal &&
                !dom.departmentSelectorModal.hidden
            ) {
                closeSelector(null);
            }
        }
    );

    document.addEventListener(
        "options-changed",
        function (event) {
            if (
                event.detail
                    ?.departmentsEnabled ===
                false
            ) {
                resetDepartmentContext();
            }

            renderDepartmentContext();
        }
    );

    document.addEventListener(
        "device-department-availability-changed",
        function (event) {
            if (
                userBypassesDeviceAvailability()
            ) {
                return;
            }

            const current =
                getCurrentDepartment();

            if (
                Number(
                    event.detail?.departmentId
                ) ===
                    Number(current.id) &&
                event.detail?.available ===
                    false
            ) {
                resetDepartmentContext();
            }
        }
    );


    document.addEventListener(
        "department-badge-color-changed",
        function (event) {
            const current =
                getCurrentDepartment();

            if (
                Number(current.id) ===
                Number(
                    event.detail?.departmentId
                )
            ) {
                current.badgeColor =
                    event.detail?.badgeColor ||
                    "default";

                writeSelectedDepartment(
                    current
                );

                renderDepartmentContext();
            }
        }
    );


    document.addEventListener(
        "departments-changed",
        function () {
            activeDepartments = [];
            localStorage.removeItem(
                ACTIVE_DEPARTMENTS_CACHE_KEY
            );
        }
    );

    window.addEventListener(
        "online",
        function () {
            if (
                isDepartmentsEnabled()
            ) {
                refreshActiveDepartments({
                    silent: true
                });
            }
        }
    );

    renderDepartmentContext();
}
