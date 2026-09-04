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
} from "./navigation.js";
import {
    initialiseProductManagement,
    renderProductsTable
} from "./products.js?v=priority10c";
import {
    initialiseTill,
    renderCart,
    renderTillProducts,
    refreshTillAvailability
} from "./till.js?v=priority13a";
import {
    initialiseSessions,
    renderSessionStatus,
    restoreCurrentOrderNumber
} from "./sessions.js?v=priority14b";
import {
    initialiseReports,
    renderReports
} from "./reports.js?v=priority13b3";
import {
    initialiseUserManagement,
    renderUsersTable
} from "./users.js?v=priority14a";
import { initialiseCloudSync, flushPendingCloudSync, refreshLocalCacheFromCloud } from "./cloud-sync.js?v=priority14b";
import { initialiseAuditLog } from "./audit-log.js?v=priority10c1";
import { initialiseOptions, refreshOptionsFromCloud } from "./options.js?v=priority11b";
import { initialiseProductions, refreshCurrentProduction } from "./productions.js?v=priority14b";

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
    initialiseProductions();
    initialiseCloudSync();

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
    document.addEventListener("user-role-changed", refreshRolePermissions);
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

            await refreshCurrentProduction({
                silent: true
            });
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
