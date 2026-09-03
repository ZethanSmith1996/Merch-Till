import { initialiseAuthentication, validateSavedSession, isCloudUsername } from "./auth.js?v=step1e";
import {
    initialiseProductDatabase,
    initialiseUsersDatabase,
    loadSalesFromDatabase,
    loadSessionsFromDatabase
} from "./database.js?v=step1e";
import {
    initialiseNavigation,
    applyNavigationPermissions
} from "./navigation.js";
import {
    initialiseProductManagement,
    renderProductsTable
} from "./products.js";
import {
    initialiseTill,
    renderCart,
    renderTillProducts,
    refreshTillAvailability
} from "./till.js";
import {
    initialiseSessions,
    renderSessionStatus,
    restoreCurrentOrderNumber
} from "./sessions.js";
import {
    initialiseReports,
    renderReports
} from "./reports.js";
import {
    initialiseUserManagement,
    renderUsersTable
} from "./users.js?v=step1f2";
import { initialiseCloudSync, flushPendingCloudSync, refreshLocalCacheFromCloud } from "./cloud-sync.js";

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

async function startApplication() {
    initialiseAuthentication();
    initialiseNavigation();
    initialiseTill();
    initialiseProductManagement();
    initialiseSessions();
    initialiseReports();
    initialiseUserManagement();
    initialiseCloudSync();

    document.addEventListener("products-changed", refreshProductDisplays);
    document.addEventListener("user-role-changed", refreshRolePermissions);
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
