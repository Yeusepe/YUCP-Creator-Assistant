import { ConvexHttpClient } from "convex/browser";
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });
import { anyApi } from "convex/server";

const convex = new ConvexHttpClient(process.env.CONVEX_URL);

async function test() {
    try {
        // Need a valid tenant ID to test this.
        // Let's first query a tenant ID.
        console.log("Testing updateTenantSetting mutation...");

        const apiSecret = process.env.CONVEX_API_SECRET;

        // We can't easily query tenant ID without knowing auth user, 
        // but the mutation arguments are what we want to test for schema validation errors.
        console.log(await convex.mutation("providerConnections:updateTenantSetting", {
            apiSecret,
            tenantId: "kd70v9q3g218hbgxykrt2cxsv978rth0", // A dummy but validly formatted ID or we can just see if it fails type validation 
            key: "allowMismatchedEmails",
            value: true,
        }));
    } catch (err) {
        console.error("Mutation failed:");
        console.error(err);
    }
}

test();
