"""Invoice model: lines, subtotal, tax and total, all in integer cents."""
from dataclasses import dataclass, field

from billing.money import format_cents, parse_amount


@dataclass
class Line:
    description: str
    unit_cents: int
    quantity: int

    @property
    def total_cents(self):
        return self.unit_cents * self.quantity


@dataclass
class Invoice:
    number: str
    tax_basis_points: int = 0          # 825 means 8.25 %
    lines: list = field(default_factory=list)

    def add_line(self, description, unit_price, quantity=1):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        line = Line(description, parse_amount(unit_price), quantity)
        self.lines.append(line)
        return line

    def subtotal_cents(self):
        return sum(line.total_cents for line in self.lines)

    def tax_cents(self):
        # Round half away from zero on the whole invoice.
        raw = self.subtotal_cents() * self.tax_basis_points
        sign = -1 if raw < 0 else 1
        return sign * ((abs(raw) + 5000) // 10000)

    def total_cents(self):
        return self.subtotal_cents() + self.tax_cents()

    def render(self):
        out = [f"Invoice {self.number}"]
        for line in self.lines:
            out.append(f"{line.description:<30} {line.quantity:>4} x {format_cents(line.unit_cents):>10}"
                       f" = {format_cents(line.total_cents):>12}")
        out.append(f"{'Subtotal':<49} {format_cents(self.subtotal_cents()):>12}")
        out.append(f"{'Tax':<49} {format_cents(self.tax_cents()):>12}")
        out.append(f"{'Total':<49} {format_cents(self.total_cents()):>12}")
        return "\n".join(out)
