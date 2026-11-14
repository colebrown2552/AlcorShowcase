# clinic-billing-export

Nightly job for the Pellbrook Physio clinic: takes the appointment export from the
booking system and writes the CSV we upload to the billing provider.

    python3 export_for_billing.py appointments.csv billing.csv

The booking system export has the columns
`appt_id,clinician,patient_ref,appt_date,length,fee_gbp,notes`.
