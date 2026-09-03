import { localTrainingUser } from "./config.js?v=step3b";
import { state } from "./state.js";

const databaseName = "MerchTillDatabase";
const databaseVersion = 4;

export function openDatabase() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(databaseName, databaseVersion);

        request.onupgradeneeded = function (event) {
            const databaseInstance = event.target.result;
            const upgradeTransaction = event.target.transaction;

            if (!databaseInstance.objectStoreNames.contains("products")) {
                databaseInstance.createObjectStore("products", {
                    keyPath: "id"
                });
            }

            if (!databaseInstance.objectStoreNames.contains("sales")) {
                const salesStore = databaseInstance.createObjectStore("sales", {
                    keyPath: "id",
                    autoIncrement: true
                });
                salesStore.createIndex("date", "date", { unique: false });
                salesStore.createIndex("createdAt", "createdAt", { unique: false });
                salesStore.createIndex("sessionId", "sessionId", { unique: false });
            } else {
                const salesStore = upgradeTransaction.objectStore("sales");
                if (!salesStore.indexNames.contains("sessionId")) {
                    salesStore.createIndex("sessionId", "sessionId", { unique: false });
                }
            }

            if (!databaseInstance.objectStoreNames.contains("sessions")) {
                const sessionsStore = databaseInstance.createObjectStore("sessions", {
                    keyPath: "id",
                    autoIncrement: true
                });
                sessionsStore.createIndex("status", "status", { unique: false });
                sessionsStore.createIndex("openedAt", "openedAt", { unique: false });
            }

            if (!databaseInstance.objectStoreNames.contains("users")) {
                const usersStore = databaseInstance.createObjectStore("users", {
                    keyPath: "id",
                    autoIncrement: true
                });
                usersStore.createIndex("username", "username", { unique: true });
                usersStore.createIndex("role", "role", { unique: false });
                usersStore.createIndex("active", "active", { unique: false });
            }
        };

        request.onsuccess = function (event) {
            state.database = event.target.result;
            resolve(state.database);
        };

        request.onerror = function () {
            console.error("Could not open the database:", request.error);
            reject(request.error);
        };
    });
}

export function loadProductsFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readonly");
        const request = transaction.objectStore("products").getAll();

        request.onsuccess = function () {
            state.products = request.result.sort(function (first, second) {
                const firstOrder = Number.isFinite(first.sortOrder)
                    ? first.sortOrder
                    : first.id;
                const secondOrder = Number.isFinite(second.sortOrder)
                    ? second.sortOrder
                    : second.id;

                if (firstOrder !== secondOrder) {
                    return firstOrder - secondOrder;
                }

                if (
                    first.groupId &&
                    second.groupId &&
                    first.groupId === second.groupId
                ) {
                    return (first.variantOrder ?? 0) - (second.variantOrder ?? 0);
                }

                return first.id - second.id;
            });
            resolve(state.products);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}



export function replaceProductCacheInDatabase(products) {
    return new Promise(function (resolve, reject) {
        const transaction =
            state.database.transaction("products", "readwrite");

        const store =
            transaction.objectStore("products");

        const clearRequest = store.clear();

        clearRequest.onerror = function () {
            reject(clearRequest.error);
        };

        clearRequest.onsuccess = function () {
            products.forEach(function (product) {
                store.put(product);
            });
        };

        transaction.oncomplete = function () {
            resolve(products);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Product cache replacement aborted.")
            );
        };
    });
}


export function saveProductToDatabase(product) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const request = transaction.objectStore("products").put(product);

        request.onsuccess = function () {
            resolve(product);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function saveProductsToDatabase(products) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const store = transaction.objectStore("products");

        products.forEach(function (product) {
            store.put(product);
        });

        transaction.oncomplete = function () {
            resolve(products);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(transaction.error || new Error("Product update aborted."));
        };
    });
}

export function deleteProductsFromDatabase(productIds) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const store = transaction.objectStore("products");

        productIds.forEach(function (productId) {
            store.delete(productId);
        });

        transaction.oncomplete = resolve;
        transaction.onerror = function () {
            reject(transaction.error);
        };
        transaction.onabort = function () {
            reject(transaction.error || new Error("Product deletion aborted."));
        };
    });
}

export function replaceProductsInDatabase(productsToSave, productIdsToDelete = []) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const store = transaction.objectStore("products");

        productsToSave.forEach(function (product) {
            store.put(product);
        });

        productIdsToDelete.forEach(function (productId) {
            store.delete(productId);
        });

        transaction.oncomplete = function () {
            resolve(productsToSave);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(transaction.error || new Error("Product replacement aborted."));
        };
    });
}

export function deleteProductFromDatabase(productId) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("products", "readwrite");
        const request = transaction.objectStore("products").delete(productId);

        request.onsuccess = resolve;
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function saveCompletedSaleTransaction(sale, updatedProducts) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction(
            ["products", "sales"],
            "readwrite"
        );

        const productStore = transaction.objectStore("products");

        // Sale IDs must be unique across every device. IndexedDB's normal
        // auto-increment counter is device-local, so two devices can both
        // create sale ID 1, 2, 3, etc. A time-based ID avoids those clashes
        // while remaining a safe integer for the Supabase bigint column.
        const uniqueSaleId =
            sale.id !== undefined &&
            sale.id !== null
                ? Number(sale.id)
                : (
                    (Date.now() * 1000) +
                    Math.floor(Math.random() * 1000)
                );

        const saleWithId = {
            ...sale,
            id: uniqueSaleId
        };

        const saleRequest =
            transaction.objectStore("sales").add(saleWithId);

        updatedProducts.forEach(function (product) {
            productStore.put(product);
        });

        saleRequest.onsuccess = function () {
            // The explicit ID is also returned by IndexedDB.
        };

        transaction.oncomplete = function () {
            resolve(uniqueSaleId);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(transaction.error || new Error("Sale transaction aborted."));
        };
    });
}



export function updateSaleOrderNumberInDatabase(
    saleId,
    orderNumber
) {
    return new Promise(function (resolve, reject) {
        const transaction =
            state.database.transaction(
                "sales",
                "readwrite"
            );

        const store =
            transaction.objectStore("sales");

        const request =
            store.get(Number(saleId));

        request.onsuccess = function () {
            const sale = request.result;

            if (!sale) {
                resolve(false);
                return;
            }

            store.put({
                ...sale,
                orderNumber:
                    Number(orderNumber)
            });
        };

        request.onerror = function () {
            reject(request.error);
        };

        transaction.oncomplete = function () {
            resolve(true);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error(
                    "Sale order-number update was aborted."
                )
            );
        };
    });
}


export function deleteSaleFromDatabase(saleId) {
    return new Promise(function (resolve, reject) {
        const transaction =
            state.database.transaction("sales", "readwrite");

        const store =
            transaction.objectStore("sales");

        store.delete(Number(saleId));

        transaction.oncomplete = function () {
            resolve(true);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Sale deletion was aborted.")
            );
        };
    });
}


export function saveVoidedSaleTransaction(sale, updatedProducts) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction(
            ["products", "sales"],
            "readwrite"
        );

        const productStore = transaction.objectStore("products");
        const salesStore = transaction.objectStore("sales");

        updatedProducts.forEach(function (product) {
            productStore.put(product);
        });

        salesStore.put(sale);

        transaction.oncomplete = function () {
            resolve(sale);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(transaction.error || new Error("Void transaction aborted."));
        };
    });
}

export function loadSalesFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sales", "readonly");
        const request = transaction.objectStore("sales").getAll();

        request.onsuccess = function () {
            state.sales = request.result.sort(function (first, second) {
                return second.createdAt.localeCompare(first.createdAt);
            });
            resolve(state.sales);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function loadSessionsFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readonly");
        const request = transaction.objectStore("sessions").getAll();

        request.onsuccess = function () {
            state.sessions = request.result.sort(function (a, b) {
                return b.openedAt.localeCompare(a.openedAt);
            });
            state.currentSession =
                state.sessions.find(function (session) {
                    return session.status === "open";
                }) || null;
            resolve(state.sessions);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}


export function replaceSessionCacheInDatabase(sessions) {
    return new Promise(function (resolve, reject) {
        const transaction =
            state.database.transaction("sessions", "readwrite");
        const store = transaction.objectStore("sessions");
        const clearRequest = store.clear();

        clearRequest.onerror = function () {
            reject(clearRequest.error);
        };

        clearRequest.onsuccess = function () {
            sessions.forEach(function (session) {
                store.put(session);
            });
        };

        transaction.oncomplete = function () {
            resolve(sessions);
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Session cache replacement aborted.")
            );
        };
    });
}


export function createSessionInDatabase(session) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readwrite");
        const request = transaction.objectStore("sessions").add(session);

        request.onsuccess = function () {
            resolve(request.result);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function closeSessionInDatabase(session) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("sessions", "readwrite");
        const request = transaction.objectStore("sessions").put(session);

        request.onsuccess = function () {
            resolve(session);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

export function replaceCloudDataInDatabase(products, sales, sessions) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction(
            ["products", "sales", "sessions"],
            "readwrite"
        );

        const productsStore = transaction.objectStore("products");
        const salesStore = transaction.objectStore("sales");
        const sessionsStore = transaction.objectStore("sessions");

        productsStore.clear();
        salesStore.clear();
        sessionsStore.clear();

        products.forEach(function (product) {
            productsStore.put(product);
        });

        sales.forEach(function (sale) {
            salesStore.put(sale);
        });

        sessions.forEach(function (session) {
            sessionsStore.put(session);
        });

        transaction.oncomplete = function () {
            resolve();
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Cloud cache replacement aborted.")
            );
        };
    });
}


export function replaceCloudCatalogueInDatabase(products, sessions) {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction(
            ["products", "sessions"],
            "readwrite"
        );

        const productsStore = transaction.objectStore("products");
        const sessionsStore = transaction.objectStore("sessions");

        productsStore.clear();
        sessionsStore.clear();

        products.forEach(function (product) {
            productsStore.put(product);
        });

        sessions.forEach(function (session) {
            sessionsStore.put(session);
        });

        transaction.oncomplete = function () {
            resolve();
        };

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Cloud catalogue replacement aborted.")
            );
        };
    });
}

export function loadUsersFromDatabase() {
    return new Promise(function (resolve, reject) {
        const transaction = state.database.transaction("users", "readonly");
        const request = transaction.objectStore("users").getAll();

        request.onsuccess = function () {
            /*
             * The local users store exists only for Training Mode now.
             * Operational users are never read from IndexedDB.
             */
            state.users = request.result
                .filter(function (user) {
                    return (
                        String(user.username || "")
                            .trim()
                            .toLowerCase() === "training"
                    );
                })
                .sort(function (first, second) {
                    return first.username.localeCompare(second.username);
                });

            resolve(state.users);
        };

        request.onerror = function () {
            reject(request.error);
        };
    });
}

export async function initialiseUsersDatabase() {
    /*
     * Migration cleanup:
     * remove every legacy local operational account/password, leaving only
     * the deliberately local Training account.
     */
    await new Promise(function (resolve, reject) {
        const transaction =
            state.database.transaction("users", "readwrite");

        const store =
            transaction.objectStore("users");

        const request =
            store.getAll();

        request.onsuccess = function () {
            const users =
                Array.isArray(request.result)
                    ? request.result
                    : [];

            let trainingRecord = null;

            users.forEach(function (user) {
                const username =
                    String(user.username || "")
                        .trim()
                        .toLowerCase();

                if (username === "training") {
                    trainingRecord = user;
                    return;
                }

                /*
                 * This removes old Master/Admin/Staff passwords from the
                 * device's IndexedDB. Those accounts now live in Supabase.
                 */
                if (user.id !== undefined) {
                    store.delete(user.id);
                }
            });

            const synchronisedTrainingUser = {
                ...(trainingRecord || {}),
                ...localTrainingUser
            };

            if (trainingRecord?.id !== undefined) {
                synchronisedTrainingUser.id =
                    trainingRecord.id;
            }

            store.put(synchronisedTrainingUser);
        };

        request.onerror = function () {
            reject(request.error);
        };

        transaction.oncomplete = resolve;

        transaction.onerror = function () {
            reject(transaction.error);
        };

        transaction.onabort = function () {
            reject(
                transaction.error ||
                new Error("Local user cleanup was aborted.")
            );
        };
    });

    await loadUsersFromDatabase();
    return state.users;
}

export async function initialiseProductDatabase() {
    await openDatabase();
    await loadProductsFromDatabase();

    /*
     * An empty product catalogue is a valid state.
     * Do not manufacture demo/default products.
     *
     * For cloud users, Supabase will subsequently refresh this local cache.
     * If Supabase also contains zero products, the Till remains empty.
     */
    return state.products;
}


