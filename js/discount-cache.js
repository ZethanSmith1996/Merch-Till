const DISCOUNT_AUTHORISERS_CACHE_KEY =
    "merchTillDiscountAuthorisersV23";


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


export function cacheDiscountAuthorisers(
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


export function getCachedDiscountAuthorisers() {
    return readCachedDiscountAuthorisers();
}


export async function validateCachedDiscountPin(
    pin
) {
    const authorisers =
        readCachedDiscountAuthorisers();

    if (
        authorisers.length === 0
    ) {
        throw new Error(
            navigator.onLine
                ? "Discount authorisation has not synchronised yet. Try again in a moment."
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
