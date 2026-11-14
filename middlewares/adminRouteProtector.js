import { protect } from "./authentication.js";

export const adminRouteProtector = protect("admin");
export default adminRouteProtector;
