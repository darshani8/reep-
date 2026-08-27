# Two-AZ VPC: public subnets carry only the ALB and the NAT gateway; the api
# tasks, the database and EFS live in private subnets and reach out through NAT
# (Bedrock, Sentry, OpenAI, Google token exchange).

# Standard availability zones ONLY, and always the same two.
#
# `state = "available"` alone also returns LOCAL ZONES. This account has the
# Kolkata local zone (ap-south-1-ccu-1a) opted in, an apply drew it as one of
# the first two names, and the whole run died on
#
#   CreateNatGateway: NotAvailableInZone: Nat Gateway is not available in
#   this availability zone
#
# because NAT gateways, RDS and Fargate do not exist in local zones. The
# opt-in-status filter is the canonical fix: a standard AZ is always
# "opt-in-not-required", while local zones, Wavelength zones and opt-in
# regions are not.
#
# `sort` is the other half. The API does not promise an order, so an unsorted
# slice can hand back a DIFFERENT pair on a later apply -- which reads as
# "replace both subnets", and replacing a subnet takes the NAT gateway, the
# database and every running task with it.
data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(sort(data.aws_availability_zones.available.names), 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index + 8)
  tags              = { Name = "${var.project}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

# One NAT gateway, not one per AZ: the saving is real and the blast radius —
# outbound calls from one AZ's tasks during a NAT AZ outage — is acceptable for
# a college dashboard. Revisit if Multi-AZ RDS is turned on.
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
