import { initialiseAuthentication, validateSavedSession, isCloudUsername } from "./auth.js?v=step1e";
import {
    initialiseProductDatabase,
    initialiseUsersDatabase,
    loadSalesFromDatabase,
    loadSessionsFromDatabase
} from "./database.js?v=step6c";
import {
    initialiseNavigation,
    applyNavigationPermissions
} from "./navigation.js?v=stage15f2";
import {
    initialiseProductManagement,
    renderProductsTable
} from "./products.js?v=stage20";
import {
    initialiseTill,
    renderCart,
    renderTillProducts,
    refreshTillAvailability
} from "./till.js?v=stage15e";
import {
    initialiseSessions,
    renderSessionStatus,
    restoreCurrentOrderNumber
} from "./sessions.js?v=stage15e1";
import {
    initialiseReports,
    renderReports
} from "./reports.js?v=priority13b3";
import {
    initialiseUserManagement,
    renderUsersTable
} from "./users.js?v=priority14a";
import {
    initialiseCloudSync,
    flushPendingCloudSync,
    refreshLocalCacheFromCloud,
    refreshLiveProductsFromCloud
} from "./cloud-sync.js?v=stage15e1";
import { initialiseAuditLog } from "./audit-log.js?v=stage15f";
import { initialiseOptions, refreshOptionsFromCloud } from "./options.js?v=stage15e";
import { initialiseDepartments } from "./departments.js?v=stage15f2";
import {
    initialiseDepartmentContext,
    renderDepartmentContext,
    ensureDepartmentContextForCurrentUser,
    getCurrentDepartment
} from "./department-context.js?v=stage15f2";
import { initialiseProductions, refreshCurrentProduction } from "./productions.js?v=stage15e1";
import { initialiseArchive } from "./archive.js?v=stage20";

function refreshProductDisplays() {
    renderTillProducts();
    renderProductsTable();
    renderCart();
}

function refreshRolePermissions() {
    applyNavigationPermissions();
    refreshTillAvailability();
    renderSessionStatus();
}


async function registerMerchTillServiceWorker() {
    if (!("serviceWorker" in navigator)) {
        return;
    }

    try {
        await navigator.serviceWorker.register(
            "./service-worker.js",
            {
                scope: "./"
            }
        );
    } catch (error) {
        /*
         * PWA registration must never prevent the Till from starting.
         */
        console.warn(
            "Merch Till service worker could not be registered:",
            error
        );
    }
}


async function startApplication() {
    registerMerchTillServiceWorker();

    initialiseAuthentication();
    initialiseNavigation();
    initialiseTill();
    initialiseProductManagement();
    initialiseSessions();
    initialiseReports();
    initialiseUserManagement();
    initialiseAuditLog();
    initialiseOptions();
    initialiseDepartments();
    initialiseDepartmentContext();
    initialiseProductions();
    initialiseArchive();
    initialiseCloudSync();

    document.addEventListener(
        "department-context-changed",
        async function () {
            if (!navigator.onLine) {
                refreshProductDisplays();
                refreshTillAvailability();
                renderSessionStatus();
                renderReports();
                renderDepartmentContext();
                return;
            }

            /*
             * Merchandise product visibility depends on the currently active
             * Production. Refresh that Production first, then fetch the
             * Department-specific product/session/sale cache.
             */
            if (
                Number(
                    getCurrentDepartment()?.id || 1
                ) === 1
            ) {
                await refreshCurrentProduction({
                    silent: true
                });
            }

            await refreshLocalCacheFromCloud();

            refreshProductDisplays();
            refreshTillAvailability();
            renderSessionStatus();
            renderReports();
            renderDepartmentContext();
        }
    );

    document.addEventListener("products-changed", refreshProductDisplays);

    document.addEventListener(
        "production-refresh-requested",
        function () {
            refreshCurrentProduction({
                silent: true
            });
        }
    );

    document.addEventListener(
        "production-changed",
        async function (event) {
            await refreshLiveProductsFromCloud();

            refreshProductDisplays();
            refreshTillAvailability();

            const autoClosedSessionIds =
                event.detail
                    ?.autoClosedSessionIds ||
                [];

            /*
             * If lifecycle processing automatically closed an expired
             * production's open session, pull the authoritative cloud state so
             * every screen immediately reflects Trading Closed.
             */
            if (
                autoClosedSessionIds.length >
                0
            ) {
                await refreshLocalCacheFromCloud()
                    .catch(function () {});
            }

            renderSessionStatus();
        }
    );
    document.addEventListener(
        "user-role-changed",
        async function () {
            refreshRolePermissions();

            const signedIn =
                sessionStorage.getItem(
                    "merchTillLoggedIn"
                ) === "true";

            if (!signedIn) {
                return;
            }

            const department =
                await ensureDepartmentContextForCurrentUser();

            if (
                department &&
                navigator.onLine
            ) {
                /*
                 * ensureDepartmentContextForCurrentUser dispatches
                 * department-context-changed, which performs the actual cloud
                 * refresh. Nothing else is required here.
                 */
                renderDepartmentContext();
            }
        }
    );
    document.addEventListener(
        "cloud-order-number-updated",
        function () {
            restoreCurrentOrderNumber();
            renderReports();
        }
    );
    document.addEventListener("cloud-data-loaded", function () {
        restoreCurrentOrderNumber();
        refreshProductDisplays();
        refreshTillAvailability();
        renderSessionStatus();
        renderReports();
    });

    try {
        await initialiseProductDatabase();
        await initialiseUsersDatabase();
        await loadSalesFromDatabase();
        await loadSessionsFromDatabase();
        restoreCurrentOrderNumber();

        await validateSavedSession();

        const signedInUsername =
            sessionStorage.getItem("merchTillUsername") || "";

        if (isCloudUsername(signedInUsername)) {
            await refreshLocalCacheFromCloud();
            await refreshOptionsFromCloud({
                silent: true
            });

            await ensureDepartmentContextForCurrentUser();

            renderDepartmentContext();

            if (
                Number(
                    getCurrentDepartment()?.id || 1
                ) === 1
            ) {
                await refreshCurrentProduction({
                    silent: true
                });
            }
        } else {
            await flushPendingCloudSync();
        }

        refreshProductDisplays();
        renderUsersTable();
        applyNavigationPermissions();
        refreshTillAvailability();
        renderSessionStatus();
        renderReports();

    } catch (error) {
        console.error("Database could not be initialised:", error);
        window.alert("The till database could not be loaded.");
    }
}

startApplication();
