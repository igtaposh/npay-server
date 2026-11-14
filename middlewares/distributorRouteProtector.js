import { protect } from "./authentication.js";

export const distributorRouteProtector = protect("distributor");
export default distributorRouteProtector;
