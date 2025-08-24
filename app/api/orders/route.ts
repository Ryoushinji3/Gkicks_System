import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { executeQuery } from '../../../lib/database/mysql'

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'

// Helper function to get user from token
async function getUserFromToken(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  
  try {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('🚫 ORDERS: No valid authorization header found')
      return null
    }

    const token = authHeader.substring(7)
    console.log('🔍 ORDERS: Token received:', token.substring(0, 50) + '...')
    console.log('🔍 ORDERS: Token length:', token.length)
    console.log('🔍 ORDERS: Token parts:', token.split('.').length)
    
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string, email: string }
    console.log('✅ ORDERS: Token verified successfully for user:', decoded.userId)
    return { id: decoded.userId, email: decoded.email }
  } catch (error) {
    console.error('❌ ORDERS: Token verification failed:', error)
    console.error('❌ ORDERS: Token that failed:', authHeader?.substring(7, 57) + '...')
    return null
  }
}

// GET - Fetch user orders
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromToken(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    console.log('🔍 API: Fetching orders for user:', user.id)
    
    // Fetch orders with proper field mapping
    const orders = await executeQuery(
      `SELECT 
        id,
        order_number,
        status,
        payment_status,
        payment_method,
        subtotal,
        tax_amount,
        shipping_amount,
        discount_amount,
        total_amount as total,
        shipping_address,
        billing_address,
        notes,
        created_at,
        updated_at
      FROM orders 
      WHERE user_id = ? 
      ORDER BY created_at DESC`,
      [user.id]
    ) as any[]

    // Fetch order items for each order
    const ordersWithItems = await Promise.all(
      orders.map(async (order: any) => {
        const items = await executeQuery(
          `SELECT 
            oi.id,
            oi.quantity,
            oi.price,
            oi.size,
            oi.color,
            p.name,
            p.brand,
            p.image_url
          FROM order_items oi
          JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = ?`,
          [order.id]
        ) as any[]

        // Convert numeric fields to proper numbers
        const processedItems = items.map(item => ({
          ...item,
          quantity: Number(item.quantity),
          price: Number(item.price)
        }))

        return {
          ...order,
          // Convert numeric fields to proper numbers
          subtotal: Number(order.subtotal),
          tax_amount: Number(order.tax_amount),
          shipping_amount: Number(order.shipping_amount),
          discount_amount: Number(order.discount_amount),
          total: Number(order.total),
          shipping_address: order.shipping_address ? JSON.parse(order.shipping_address) : null,
          items: processedItems
        }
      })
    )

    console.log(`✅ API: Successfully fetched ${ordersWithItems.length} orders`)
    return NextResponse.json(ordersWithItems)

  } catch (error) {
    console.error('❌ API: Error fetching orders:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Create new order
export async function POST(request: NextRequest) {
  try {
    // Get user from JWT token
    const user = await getUserFromToken(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const {
      items,
      total,
      customer_email,
      shipping_address,
      payment_method,
      payment_screenshot,
      status = 'pending'
    } = body

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'Order items are required' },
        { status: 400 }
      )
    }

    if (!total || !customer_email) {
      return NextResponse.json(
        { error: 'Total amount and customer email are required' },
        { status: 400 }
      )
    }

    console.log('🔍 API: Creating new order for:', customer_email, 'User ID:', user.id)

    // Validate stock availability for all items before creating order
    for (const item of items) {
      const productResult = await executeQuery(
        'SELECT variants, stock_quantity FROM products WHERE id = ?',
        [item.product_id]
      ) as any[]

      if (!Array.isArray(productResult) || productResult.length === 0) {
        return NextResponse.json(
          { error: `Product not found: ${item.product_name}` },
          { status: 400 }
        )
      }

      const product = productResult[0] as any
      let variants: Record<string, Record<string, number>>
      
      try {
        variants = product.variants ? JSON.parse(product.variants) : {}
      } catch (e) {
        variants = {}
      }

      const availableStock = variants[item.color]?.[item.size] || 0
      
      if (availableStock < item.quantity) {
        return NextResponse.json(
          { 
            error: 'Insufficient stock', 
            message: `Only ${availableStock} items available for ${item.product_name} (${item.color}, ${item.size})`,
            product: item.product_name,
            color: item.color,
            size: item.size,
            availableStock,
            requestedQuantity: item.quantity
          },
          { status: 400 }
        )
      }
    }

    // Process stock reduction for all items
    for (const item of items) {
      const stockResponse = await fetch(`${request.nextUrl.origin}/api/products/stock?id=${item.product_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': request.headers.get('authorization') || ''
        },
        body: JSON.stringify({
          color: item.color,
          size: item.size,
          quantity: item.quantity
        })
      })

      if (!stockResponse.ok) {
        const stockError = await stockResponse.json()
        return NextResponse.json(
          { 
            error: 'Stock update failed', 
            message: stockError.message || `Failed to update stock for ${item.product_name}`,
            product: item.product_name
          },
          { status: 400 }
        )
      }
    }

    // Generate order number
    const orderNumber = `GK${Date.now()}`

    // Create the order
    const result = await executeQuery(
      `INSERT INTO orders (
         user_id, order_number, status, total_amount, 
         shipping_address, payment_method, payment_screenshot
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        orderNumber,
        status || 'pending',
        total || 0, // total_amount
        JSON.stringify(shipping_address || {}),
        payment_method || null,
        payment_screenshot || null
      ]
    ) as any

    const orderId = (result as any).insertId

    // Insert order items
    for (const item of items) {
      await executeQuery(
        `INSERT INTO order_items (
           order_id, product_id, quantity, size, color, price
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.product_id,
          item.quantity,
          item.size || null,
          item.color || null,
          item.price
        ]
      )
    }

    // Fetch the created order with items
    const newOrder = await executeQuery(
      `SELECT * FROM orders WHERE id = ?`,
      [orderId]
    ) as any[]

    const orderItems = await executeQuery(
      `SELECT * FROM order_items WHERE order_id = ?`,
      [orderId]
    ) as any[]

    const order = newOrder[0] as any
    // Parse JSON fields and add items
    const parsedOrder = {
      ...order,
      shipping_address: order.shipping_address ? JSON.parse(order.shipping_address) : null,
      items: orderItems
    }

    console.log('✅ API: Successfully created order:', orderNumber)
    return NextResponse.json(parsedOrder, { status: 201 })

  } catch (error) {
    console.error('❌ API: Error creating order:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// PUT - Update order status
export async function PUT(request: NextRequest) {
  try {
    const user = await getUserFromToken(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    
    if (!id) {
      return NextResponse.json(
        { error: 'Order ID is required' },
        { status: 400 }
      )
    }

    const body = await request.json()
    const { status, tracking_number } = body

    if (!status) {
      return NextResponse.json(
        { error: 'Status is required' },
        { status: 400 }
      )
    }

    console.log('🔍 API: Updating order status:', id, 'to:', status)

    const result = await executeQuery(
      `UPDATE orders 
       SET status = ?, tracking_number = ?, updated_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [status, tracking_number || null, id, user.id]
    ) as any

    if ((result as any).affectedRows === 0) {
      return NextResponse.json(
        { error: 'Order not found or unauthorized' },
        { status: 404 }
      )
    }

    // Fetch the updated order
    const updatedOrder = await executeQuery(
      `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
      [id, user.id]
    ) as any[]

    const order = Array.isArray(updatedOrder) && updatedOrder.length > 0 ? updatedOrder[0] as any : null;
    if (!order) {
      return NextResponse.json(
        { error: 'Order not found' },
        { status: 404 }
      );
    }
    const parsedOrder = {
      ...order,
      shipping_address: order.shipping_address ? JSON.parse(order.shipping_address) : null,
      items: order.items ? JSON.parse(order.items) : []
    }

    console.log('✅ API: Successfully updated order status')
    return NextResponse.json(parsedOrder)

  } catch (error) {
    console.error('❌ API: Error updating order:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}