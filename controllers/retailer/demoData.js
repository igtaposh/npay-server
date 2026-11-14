// Prototype fixtures used only when DEMO_MODE=true outside production.
export const planCategories = [
    { id: "popular", label: "Popular" },
    { id: "unlimited", label: "Unlimited" },
    { id: "data", label: "Data" },
    { id: "talktime", label: "Talktime" },
    { id: "isd", label: "ISD" },
    { id: "topup", label: "TopUp" },
];
export const prepaidPlans = [
    {
        id: "pop-199",
        amount: 199,
        data: "1.5 GB/day",
        validity: "28 days",
        description: "Unlimited calls + 100 SMS/day. Ideal everyday pack.",
        category: "popular",
        tag: "Most chosen",
    },
    {
        id: "pop-299",
        amount: 299,
        data: "2 GB/day",
        validity: "28 days",
        description: "Extra daily data with unlimited voice across India.",
        category: "popular",
        tag: "Best value",
    },
    {
        id: "pop-399",
        amount: 399,
        data: "2 GB/day",
        validity: "28 days",
        description: "Extra daily data with unlimited voice across India.",
        category: "popular",
        tag: "Best value",
    },
    {
        id: "pop-499",
        amount: 499,
        data: "2 GB/day",
        validity: "28 days",
        description: "Extra daily data with unlimited voice across India.",
        category: "popular",
        tag: "Best value",
    },
    {
        id: "pop-599",
        amount: 599,
        data: "2 GB/day",
        validity: "28 days",
        description: "Extra daily data with unlimited voice across India.",
        category: "popular",
        tag: "Best value",
    },
    {
        id: "pop-719",
        amount: 719,
        data: "1.5 GB/day",
        validity: "84 days",
        description: "Long-validity pack with unlimited calls and SMS.",
        category: "popular",
    },
    {
        id: "unl-349",
        amount: 349,
        data: "2.5 GB/day",
        validity: "28 days",
        description: "Truly unlimited voice with a generous daily data bucket.",
        category: "unlimited",
        tag: "Unlimited",
    },
    {
        id: "unl-666",
        amount: 666,
        data: "1.5 GB/day",
        validity: "56 days",
        description: "Two-month unlimited calling with steady daily data.",
        category: "unlimited",
    },
    {
        id: "unl-2999",
        amount: 2999,
        data: "2.5 GB/day",
        validity: "365 days",
        description: "Annual unlimited plan with year-long peace of mind.",
        category: "unlimited",
        tag: "Annual",
    },
    {
        id: "data-15",
        amount: 15,
        data: "1 GB",
        validity: "1 day",
        description: "Quick top-up for a short data boost.",
        category: "data",
    },
    {
        id: "data-61",
        amount: 61,
        data: "6 GB",
        validity: "7 days",
        description: "Weekend binge pack for streaming and downloads.",
        category: "data",
    },
    {
        id: "data-181",
        amount: 181,
        data: "30 GB",
        validity: "30 days",
        description: "Monthly data add-on without changing your base plan.",
        category: "data",
        tag: "Add-on",
    },
    {
        id: "tt-10",
        amount: 10,
        data: "—",
        validity: "Lifetime",
        description: "₹7.47 talktime after GST. No validity limit.",
        category: "talktime",
    },
    {
        id: "tt-50",
        amount: 50,
        data: "—",
        validity: "Lifetime",
        description: "₹39.37 talktime after GST for local and STD calls.",
        category: "talktime",
    },
    {
        id: "tt-100",
        amount: 100,
        data: "—",
        validity: "Lifetime",
        description: "₹81.75 talktime after GST. Instant wallet credit.",
        category: "talktime",
    },
    {
        id: "isd-18",
        amount: 18,
        data: "—",
        validity: "28 days",
        description: "ISD calling rates for USA, Canada, and UK.",
        category: "isd",
    },
    {
        id: "isd-49",
        amount: 49,
        data: "—",
        validity: "28 days",
        description: "Broader ISD pack covering Middle East destinations.",
        category: "isd",
    },
];
export function getPlansByCategory(category) {
    return prepaidPlans.filter((plan) => plan.category === category);
}
export function findPlanByAmount(amount) {
    return prepaidPlans.find((plan) => plan.amount === amount);
}

export const dthProviders = [
    {
        id: "tata-play",
        name: "Tata Play",
        digits: 10,
        sampleNumber: "1001234567",
        numberName: "subscriber ID",
    },
    {
        id: "airtel-dth",
        name: "Airtel Digital TV",
        digits: 10,
        sampleNumber: "3012345678",
        numberName: "customer ID",
    },
    {
        id: "dishtv",
        name: "Dish TV",
        digits: 11,
        sampleNumber: "01512345678",
        numberName: "VC number",
    },
    {
        id: "d2h",
        name: "d2h",
        digits: 11,
        sampleNumber: "10234567890",
        numberName: "VC number",
    },
    {
        id: "sun-direct",
        name: "Sun Direct",
        digits: 11,
        sampleNumber: "40123456789",
        numberName: "smart card number",
    },
];
const names = [
    "Rahul Sharma",
    "Priya Nair",
    "Amit Verma",
    "Sneha Iyer",
    "Karthik Rajan",
    "Meera Joshi",
    "Arjun Patel",
    "Fatima Khan",
    "Vikram Singh",
    "Ananya Das",
    "Rohit Menon",
    "Divya Kapoor",
];
const plansByProvider = {
    "tata-play": [
        {
            name: "Hindi HD Family",
            channels: "350+ channels",
            amount: 349,
            validity: "30 days",
        },
        {
            name: "Sports HD",
            channels: "280+ channels",
            amount: 399,
            validity: "30 days",
        },
        {
            name: "Basic SD",
            channels: "180+ channels",
            amount: 249,
            validity: "30 days",
        },
    ],
    "airtel-dth": [
        {
            name: "Mega HD",
            channels: "320+ channels",
            amount: 399,
            validity: "30 days",
        },
        {
            name: "Value Sports",
            channels: "260+ channels",
            amount: 349,
            validity: "30 days",
        },
        {
            name: "Mini Pack",
            channels: "150+ channels",
            amount: 229,
            validity: "30 days",
        },
    ],
    dishtv: [
        {
            name: "Super Family",
            channels: "240+ channels",
            amount: 320,
            validity: "30 days",
        },
        {
            name: "All Sports HD",
            channels: "210+ channels",
            amount: 370,
            validity: "30 days",
        },
        {
            name: "Joy Pack",
            channels: "140+ channels",
            amount: 199,
            validity: "30 days",
        },
    ],
    d2h: [
        {
            name: "Gold HD",
            channels: "300+ channels",
            amount: 365,
            validity: "30 days",
        },
        {
            name: "Family Delight",
            channels: "220+ channels",
            amount: 299,
            validity: "30 days",
        },
        {
            name: "South Special",
            channels: "190+ channels",
            amount: 275,
            validity: "30 days",
        },
    ],
    "sun-direct": [
        {
            name: "Tamil HD Prime",
            channels: "220+ channels",
            amount: 280,
            validity: "30 days",
        },
        {
            name: "All South HD",
            channels: "250+ channels",
            amount: 330,
            validity: "30 days",
        },
        {
            name: "Starter Pack",
            channels: "120+ channels",
            amount: 179,
            validity: "30 days",
        },
    ],
};
const sampleCustomers = {
    "tata-play": {
        consumerNumber: "1001234567",
        name: "Rahul Sharma",
        status: "Active",
        plan: plansByProvider["tata-play"][0],
        dueAmount: 349,
        dueDate: "18 Nov 2026",
    },
    "airtel-dth": {
        consumerNumber: "3012345678",
        name: "Priya Nair",
        status: "Active",
        plan: plansByProvider["airtel-dth"][0],
        dueAmount: 399,
        dueDate: "21 Nov 2026",
    },
    dishtv: {
        consumerNumber: "01512345678",
        name: "Amit Verma",
        status: "Active",
        plan: plansByProvider.dishtv[0],
        dueAmount: 320,
        dueDate: "2 Dec 2026",
    },
    d2h: {
        consumerNumber: "10234567890",
        name: "Sneha Iyer",
        status: "Active",
        plan: plansByProvider.d2h[0],
        dueAmount: 365,
        dueDate: "15 Nov 2026",
    },
    "sun-direct": {
        consumerNumber: "40123456789",
        name: "Karthik Rajan",
        status: "Active",
        plan: plansByProvider["sun-direct"][0],
        dueAmount: 280,
        dueDate: "9 Dec 2026",
    },
};
function seedFrom(value) {
    return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}
export function providerInitials(name) {
    const compact = name.replace(/[^A-Za-z0-9]/g, "");
    if (compact.length <= 3)
        return compact.toUpperCase();
    return name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}
export function lookupDthCustomer(providerId, consumerNumber) {
    const sample = sampleCustomers[providerId];
    if (sample.consumerNumber === consumerNumber)
        return sample;
    const plans = plansByProvider[providerId];
    const seed = seedFrom(consumerNumber);
    const plan = plans[seed % plans.length];
    const inactive = consumerNumber.endsWith("9");
    const day = (seed % 27) + 1;
    const months = ["Nov 2026", "Dec 2026", "Jan 2027"];
    return {
        consumerNumber,
        name: names[seed % names.length],
        status: inactive ? "Inactive" : "Active",
        plan,
        dueAmount: inactive ? plan.amount * 2 : plan.amount,
        dueDate: `${day} ${months[seed % months.length]}`,
    };
}
