<?php
/**
 * AlcorFields HTML reader: a small, strict tokenizer and tree builder for authored templates and inline values.
 *
 * It never repairs markup. A document that is not well nested is refused with a line number, so every element keeps
 * one exact start and end offset in the authored bytes and rendering can copy everything it does not change byte for
 * byte. This file and the type and template classes are plain PHP with no WordPress calls: define ALCOR_FIELDS_CLI
 * to load them outside WordPress, for example to check a template from a build script.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'ALCOR_FIELDS_CLI' ) ) {
	exit;
}

/**
 * Strict HTML parser and small string helpers shared by the template and type classes.
 */
final class Alcor_Fields_Html {

	const VOID     = array( 'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr' );
	const RAW_TEXT = array( 'script', 'style', 'textarea', 'title' );
	const FOREIGN  = array( 'svg', 'math' );

	/**
	 * Parses a whole document or a fragment into a tree.
	 *
	 * @param mixed  $html  The markup.
	 * @param string $label Name used in error messages, such as the template file name.
	 * @return Alcor_Fields_Node The root node.
	 * @throws Alcor_Fields_Error On anything ambiguous: bad UTF-8, a duplicate attribute, a tag that is not closed
	 *                            by its own end tag, an unterminated comment or script.
	 */
	public static function parse( $html, $label = 'template' ) {
		if ( ! is_string( $html ) ) {
			throw Alcor_Fields_Error::at( $label, 'markup must be a string' );
		}
		if ( ! preg_match( '//u', $html ) ) {
			throw Alcor_Fields_Error::at( $label, 'markup is not valid UTF-8' );
		}
		$len               = strlen( $html );
		$root              = new Alcor_Fields_Node( 'root' );
		$root->end         = $len;
		$root->close_start = $len;
		$stack             = array( $root );
		$foreign           = 0;
		$pos               = 0;
		while ( $pos < $len ) {
			$lt = strpos( $html, '<', $pos );
			if ( false === $lt ) {
				self::leaf( end( $stack ), 'text', $pos, $len );
				break;
			}
			if ( $lt > $pos ) {
				self::leaf( end( $stack ), 'text', $pos, $lt );
			}
			if ( 0 === substr_compare( $html, '<!--', $lt, 4 ) ) {
				$close = strpos( $html, '-->', $lt + 4 );
				if ( false === $close ) {
					throw self::fail( $html, $lt, $label, 'unterminated comment' );
				}
				self::leaf( end( $stack ), 'comment', $lt, $close + 3 );
				$pos = $close + 3;
				continue;
			}
			// Look at the next byte before any pattern that needs a closing '>': PCRE scans ahead for a required
			// character, so trying those patterns at every stray '<' would be quadratic on hostile input.
			$next = $html[ $lt + 1 ] ?? '';
			if ( '!' === $next && 0 === strncasecmp( substr( $html, $lt, 9 ), '<!doctype', 9 ) ) {
				$gt = strpos( $html, '>', $lt );
				if ( false === $gt ) {
					throw self::fail( $html, $lt, $label, 'unterminated doctype' );
				}
				self::leaf( end( $stack ), 'doctype', $lt, $gt + 1 );
				$pos = $gt + 1;
				continue;
			}
			if ( '/' === $next && preg_match( '/\G<\/([A-Za-z][A-Za-z0-9:-]*)/A', $html, $m, 0, $lt ) ) {
				$after  = $lt + strlen( $m[0] );
				$after += strspn( $html, " \t\n\r\f", $after );
				if ( '>' !== ( $html[ $after ] ?? '' ) ) {
					throw self::fail( $html, $lt, $label, 'malformed end tag' );
				}
				$name = strtolower( $m[1] );
				$top  = end( $stack );
				if ( 'element' !== $top->type || $top->name !== $name ) {
					throw self::fail(
						$html,
						$lt,
						$label,
						'end tag </' . $name . '> does not close <' . ( 'element' === $top->type ? $top->name : 'document' ) . '> (templates must be well nested)'
					);
				}
				$top->close_start = $lt;
				$top->end         = $after + 1;
				array_pop( $stack );
				if ( in_array( $name, self::FOREIGN, true ) ) {
					$foreign--;
				}
				$pos = $top->end;
				continue;
			}
			if ( ! preg_match( '/\G<([A-Za-z][A-Za-z0-9:-]*)/A', $html, $m, 0, $lt ) ) {
				if ( isset( $html[ $lt + 1 ] ) && ( '!' === $html[ $lt + 1 ] || '?' === $html[ $lt + 1 ] || '/' === $html[ $lt + 1 ] ) ) {
					throw self::fail( $html, $lt, $label, 'unsupported markup declaration' );
				}
				self::leaf( end( $stack ), 'text', $lt, $lt + 1 );
				$pos = $lt + 1;
				continue;
			}
			$node        = new Alcor_Fields_Node( 'element' );
			$node->name  = strtolower( $m[1] );
			$node->start = $lt;
			$at          = $lt + strlen( $m[0] );
			$seen        = array();
			while ( preg_match( '/\G(\s+)([^\s"\'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/A', $html, $a, PREG_UNMATCHED_AS_NULL, $at ) ) {
				$name = strtolower( $a[2] );
				if ( isset( $seen[ $name ] ) ) {
					throw self::fail( $html, $at, $label, 'duplicate attribute ' . $name );
				}
				$seen[ $name ] = true;
				$raw           = $a[3] ?? $a[4] ?? $a[5];
				$node->attrs[] = array(
					'name'       => $name,
					'value'      => null === $raw ? null : html_entity_decode( $raw, ENT_QUOTES | ENT_HTML5, 'UTF-8' ),
					'start'      => $at,
					'name_start' => $at + strlen( $a[1] ),
					'end'        => $at + strlen( $a[0] ),
				);
				$at += strlen( $a[0] );
			}
			$at          += strspn( $html, " \t\n\r\f", $at );
			$self_closing = '/' === ( $html[ $at ] ?? '' );
			if ( $self_closing ) {
				$at++;
			}
			if ( '>' !== ( $html[ $at ] ?? '' ) ) {
				throw self::fail( $html, $lt, $label, 'malformed <' . $node->name . '> tag' );
			}
			$node->open_end     = $at + 1;
			$parent             = end( $stack );
			$node->parent       = $parent;
			$parent->children[] = $node;
			if ( in_array( $node->name, self::VOID, true ) || ( $self_closing && $foreign > 0 ) ) {
				$node->close_start   = $node->open_end;
				$node->end           = $node->open_end;
				$node->closed_inline = true;
				$pos                 = $node->open_end;
				continue;
			}
			if ( $self_closing ) {
				throw self::fail( $html, $lt, $label, '<' . $node->name . '/> is not self-closing in HTML' );
			}
			if ( in_array( $node->name, self::RAW_TEXT, true ) && 0 === $foreign ) {
				if ( ! preg_match( '/<\/' . $node->name . '\s*>/i', $html, $e, PREG_OFFSET_CAPTURE, $node->open_end ) ) {
					throw self::fail( $html, $lt, $label, 'unterminated <' . $node->name . '>' );
				}
				if ( $e[0][1] > $node->open_end ) {
					self::leaf( $node, 'text', $node->open_end, $e[0][1] );
				}
				$node->close_start = $e[0][1];
				$node->end         = $e[0][1] + strlen( $e[0][0] );
				$pos               = $node->end;
				continue;
			}
			if ( in_array( $node->name, self::FOREIGN, true ) ) {
				$foreign++;
			}
			$stack[] = $node;
			$pos     = $node->open_end;
		}
		if ( count( $stack ) > 1 ) {
			$open = end( $stack );
			throw self::fail( $html, $open->start, $label, '<' . $open->name . '> is never closed' );
		}
		return $root;
	}

	/**
	 * Appends a childless node (text, comment or doctype) to a parent.
	 *
	 * @param Alcor_Fields_Node $parent Node that receives the new child.
	 * @param string            $type   text, comment or doctype.
	 * @param int               $start  Offset of the first byte.
	 * @param int               $end    Offset just after the last byte.
	 * @return Alcor_Fields_Node The new node.
	 */
	private static function leaf( $parent, $type, $start, $end ) {
		$node              = new Alcor_Fields_Node( $type );
		$node->start       = $start;
		$node->open_end    = $start;
		$node->close_start = $start;
		$node->end         = $end;
		$node->parent      = $parent;
		$parent->children[] = $node;
		return $node;
	}

	/**
	 * Builds the error for a problem at a byte offset, reported by line number.
	 *
	 * @param string $html    The markup being parsed.
	 * @param int    $offset  Byte offset of the problem.
	 * @param string $label   Name used in error messages.
	 * @param string $message What is wrong.
	 * @return Alcor_Fields_Error
	 */
	private static function fail( $html, $offset, $label, $message ) {
		return Alcor_Fields_Error::at( $label . ' line ' . self::line( $html, $offset ), $message );
	}

	/**
	 * Returns the 1-based line number of a byte offset.
	 *
	 * @param string $html   The markup.
	 * @param int    $offset Byte offset; clamped to the string.
	 * @return int
	 */
	public static function line( $html, $offset ) {
		return substr_count( $html, "\n", 0, max( 0, min( $offset, strlen( $html ) ) ) ) + 1;
	}

	/**
	 * Returns the bytes between two offsets.
	 *
	 * @param string $html  The markup.
	 * @param int    $start First offset.
	 * @param int    $end   Offset just after the last byte wanted.
	 * @return string
	 */
	public static function slice( $html, $start, $end ) {
		return (string) substr( $html, $start, $end - $start );
	}

	/**
	 * Returns the markup between an element's start and end tags.
	 *
	 * @param string            $html The markup the node was parsed from.
	 * @param Alcor_Fields_Node $node An element.
	 * @return string
	 */
	public static function inner( $html, Alcor_Fields_Node $node ) {
		return self::slice( $html, $node->open_end, $node->close_start );
	}

	/**
	 * Decodes HTML entities in text.
	 *
	 * @param string $text Text with entities.
	 * @return string
	 */
	public static function decode( $text ) {
		return html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
	}

	/**
	 * Escapes text for use as element content.
	 *
	 * @param string $text Plain text.
	 * @return string
	 */
	public static function esc_text( $text ) {
		return htmlspecialchars( $text, ENT_NOQUOTES | ENT_HTML5 | ENT_SUBSTITUTE, 'UTF-8' );
	}

	/**
	 * Escapes text for use inside a quoted attribute value.
	 *
	 * @param string $text Plain text.
	 * @return string
	 */
	public static function esc_attr( $text ) {
		return htmlspecialchars( $text, ENT_QUOTES | ENT_HTML5 | ENT_SUBSTITUTE, 'UTF-8' );
	}
}
