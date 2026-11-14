import unittest
from datetime import date

from payroll.payslips import build_payslips

EMPLOYEES = """employee_id,name,hourly_rate,pension
E1,Dana Fox,20.00,yes
E2,Sam Ortiz,35.50,no
E3,Ira Bell,18,yes
"""

TIMESHEET = """employee_id,date,hours
E1,2026-03-02,8
E1,2026-03-03,8
E2,2026-03-02,7.5
"""


class PayslipTests(unittest.TestCase):
    def test_simple_period(self):
        report = build_payslips(TIMESHEET, EMPLOYEES, "March 2026")
        self.assertTrue(report.startswith("PAYSLIPS - March 2026\n"))
        self.assertIn("Dana Fox (E1) @ 20.00/h", report)
        self.assertIn("  regular      16.00 h         320.00", report)
        self.assertIn("No hours recorded: Ira Bell", report)
        self.assertIn("2 payslip(s)", report)

    def test_overtime_and_holiday(self):
        sheet = "employee_id,date,hours\n" + "".join(
            f"E2,2026-03-{d:02d},10\n" for d in range(2, 7)) + "E2,2026-03-07,4\n"
        report = build_payslips(sheet, EMPLOYEES, "Wk 10", holidays=[date(2026, 3, 7)])
        self.assertIn("  overtime     10.00 h         532.50", report)
        self.assertIn("  holiday       4.00 h         284.00", report)

    def test_warnings_listed(self):
        sheet = "employee_id,date,hours\nE9,2026-03-02,8\nE1,2026-02-30,8\nE1,2026-03-02,abc\n"
        report = build_payslips(sheet, EMPLOYEES, "X")
        self.assertIn("3 warning(s):", report)
        self.assertIn("unknown employee 'E9'", report)


if __name__ == "__main__":
    unittest.main()
