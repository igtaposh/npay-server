import { protect } from "./authentication.js";

export const retailerRouteProtector = protect("retailer");
export default retailerRouteProtector;
