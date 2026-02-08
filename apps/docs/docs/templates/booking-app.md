---
sidebar_position: 7
title: Booking App
slug: /templates/booking-app
---

# Booking App Template

An appointment and reservation system with calendar views, service selection, and booking management. Perfect for service businesses.

## What's included

- **Service catalog** — List of available services with duration and pricing
- **Calendar view** — Visual calendar showing available and booked time slots
- **Booking form** — Select a service, date, time, and provide contact details
- **Booking management** — View, confirm, and manage all bookings
- **Status tracking** — Track booking status: Pending, Confirmed, Completed, Cancelled

## Data model

**Service**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Service name (e.g., "Haircut") |
| Duration | Number | Length in minutes |
| Price | Number | Service cost |
| Description | Text | Service details |

**Booking**
| Field | Type | Description |
|-------|------|-------------|
| Service | Reference | Selected service |
| Date | Date | Appointment date |
| Time | Text | Appointment time |
| Customer name | Text | Who booked |
| Customer email | Text | Contact email |
| Customer phone | Text | Contact phone |
| Status | Selection | Pending, Confirmed, Completed, Cancelled |
| Notes | Text | Special requests |

## Getting started

1. Go to **Templates** and select **Booking App**.
2. Click **Use Template** to create your project.
3. Add some services and try making a booking.
4. Customize it for your business.

## Customization ideas

> "Add staff members and let customers choose who they want to book with."

> "Add email confirmation when a booking is made."

> "Create a public booking page that customers can access without logging in."

> "Add recurring appointments — weekly, biweekly, or monthly."

> "Add a waitlist feature for fully booked time slots."

## Who this is for

- Hair salons, barbershops, and spas
- Medical and dental practices
- Consulting and coaching businesses
- Fitness studios and personal trainers
- Any service-based business that takes appointments
