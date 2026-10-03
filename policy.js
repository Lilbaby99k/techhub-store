// Your store's policy details. Edit the values below: the Terms, Privacy, Delivery & Returns and FAQ pages use them.
// Have a lawyer review those pages before you launch. They are a sensible starting point, not legal advice.
const POLICY = {
  businessName: '',                       // registered business name. Leave empty to use your store name.
  returnDays: 7,                          // days after delivery that customers can ask to return a faulty or wrong item
  refundDays: '5 to 10 business days',    // how long a refund takes once the return is approved
  deliveryLagos: '1 to 3 business days',
  deliveryElsewhere: '3 to 7 business days',
  deliveryDays: { lagos: [1, 3], other: [3, 7] },   // business days (Mon to Fri) used for the delivery date shown to customers
  deliveryHours: '9am to 6pm',            // delivery window shown to customers
  whatsapp: '',                           // e.g. '2348012345678' (country code, no + or spaces). Leave empty to hide the button.
  hours: 'Monday to Saturday, 8am to 6pm',   // shown in the footer; leave '' to hide
  social: { instagram: '', facebook: '', x: '', tiktok: '', youtube: '' },   // paste full https:// links; empty ones are hidden
  lastUpdated: 'October 2026',
};